import { applyCheck, type CheckOutcome, statusChanged } from '@uptime/core';
import { type ClaimedMonitor, claimDueMonitors } from './claim';
import {
  buildWriteStatements,
  type EvaluatedCheck,
  releaseStatement,
  type StatementKind,
} from './persist';
import { type CheckResult, MAX_CONCURRENT_CHECKS } from './run-checks';

/**
 * Never more than this, whatever MAX_CHECKS_PER_TICK says. A request chain allows 32
 * invocations, and the tick deadline caps the real number well below this.
 */
export const HARD_MAX_CHECKS_PER_TICK = 200;

/** Checks per CheckRunner call: one invocation fits about 10 inside the 10 ms CPU limit. */
export const CHECKS_PER_GROUP = 10;

/**
 * A group only starts if it would finish, even if every check in it timed out, within this
 * long after the tick started. Keeping ticks under a minute means a 60 s monitor can't be
 * claimed again while the tick that claimed it is still running (the lease only holds
 * while the interval is longer than the tick). The first group always runs, so a group of
 * monitors with very long timeouts can still overrun; keep timeouts at 20 s or less.
 */
export const TICK_DEADLINE_MS = 50_000;

/** Runs one group of checks in a separate invocation (CheckRunner through ctx.exports). */
export type RunGroup = (monitors: ClaimedMonitor[]) => Promise<CheckResult[]>;

export interface TickDeps {
  db: D1Database;
  runGroup: RunGroup;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (entry: Record<string, unknown>) => void;
  tickId: string;
  maxChecks: number;
  /** SPIKE (Phase 0 P6): pause before writing results. */
  slowTickMs: number;
  /** Defaults to TICK_DEADLINE_MS; tests shorten it. */
  deadlineMs?: number;
}

export interface TickStats {
  claimed: number;
  checked: number;
  /** Claimed but not checked (deadline or runner failure), handed back for the next tick. */
  released: number;
  groups: number;
  runnerErrors: number;
  failures: number;
  slow: number;
  transitions: { monitorId: number; from: string; to: string }[];
  statements: number;
  rowsWritten: Record<'claim' | StatementKind | 'total', number>;
  rowsRead: number;
  latencyMs: { p50: number | null; p95: number | null; max: number | null };
  durationMs: number;
}

const USAGE_SQL = `
INSERT INTO usage_daily (day, ticks, checks, rows_written, rows_read)
VALUES (?1, 1, ?2, ?3, ?4)
ON CONFLICT (day) DO UPDATE SET
  ticks = ticks + 1,
  checks = checks + excluded.checks,
  rows_written = rows_written + excluded.rows_written,
  rows_read = rows_read + excluded.rows_read`;

/**
 * One cron tick: claim due monitors, check them in groups of CHECKS_PER_GROUP (one group
 * at a time, each in its own invocation), write everything in one batch, record usage,
 * log one line. Three D1 calls per tick: claim, batch, usage.
 */
export async function runTick(scheduledTime: number, deps: TickDeps): Promise<TickStats> {
  const startedAt = deps.now();
  const deadline = startedAt + (deps.deadlineMs ?? TICK_DEADLINE_MS);
  const limit = Math.min(Math.max(deps.maxChecks, 1), HARD_MAX_CHECKS_PER_TICK);

  const claim = await claimDueMonitors(deps.db, scheduledTime, limit);

  const results = new Map<number, CheckResult>();
  let groups = 0;
  let runnerErrors = 0;
  for (const [index, group] of chunk(claim.monitors, CHECKS_PER_GROUP).entries()) {
    if (index > 0 && deps.now() + worstCaseMs(group) > deadline) break;
    groups++;
    try {
      for (const result of await deps.runGroup(group)) results.set(result.monitorId, result);
    } catch (error) {
      // The runner failing says nothing about the monitors, so they are released, not failed.
      runnerErrors++;
      deps.log({ event: 'runner_failed', tickId: deps.tickId, error: String(error) });
    }
  }
  if (deps.slowTickMs > 0) await deps.sleep(deps.slowTickMs);

  const checks = claim.monitors.flatMap((monitor) => {
    const result = results.get(monitor.id);
    return result ? [evaluate(monitor, result)] : [];
  });
  const unchecked = claim.monitors.filter((monitor) => !results.has(monitor.id));

  const { statements, kinds } = buildWriteStatements(deps.db, checks);
  if (unchecked.length > 0) {
    statements.push(
      releaseStatement(
        deps.db,
        unchecked.map((m) => m.id),
        scheduledTime,
      ),
    );
    kinds.push('release');
  }
  const batch = statements.length > 0 ? await deps.db.batch(statements) : [];

  const rowsWritten = {
    claim: claim.meta.rows_written,
    rollup: 0,
    monitor: 0,
    event: 0,
    release: 0,
    total: 0,
  };
  let rowsRead = claim.meta.rows_read;
  batch.forEach((result, i) => {
    rowsWritten[kinds[i] as StatementKind] += result.meta.rows_written;
    rowsRead += result.meta.rows_read;
  });
  rowsWritten.total =
    rowsWritten.claim +
    rowsWritten.rollup +
    rowsWritten.monitor +
    rowsWritten.event +
    rowsWritten.release;

  await deps.db
    .prepare(USAGE_SQL)
    .bind(utcDay(scheduledTime), checks.length, rowsWritten.total, rowsRead)
    .run();

  const stats: TickStats = {
    claimed: claim.monitors.length,
    checked: checks.length,
    released: unchecked.length,
    groups,
    runnerErrors,
    failures: checks.filter((c) => c.outcome === 'FAIL').length,
    slow: checks.filter((c) => c.outcome === 'SLOW').length,
    transitions: checks.flatMap((c) =>
      c.transition ? [{ monitorId: c.result.monitorId, ...c.transition }] : [],
    ),
    statements: statements.length,
    rowsWritten,
    rowsRead,
    latencyMs: latencySummary(checks.map((c) => c.result)),
    durationMs: deps.now() - startedAt,
  };
  deps.log({
    event: 'tick',
    tickId: deps.tickId,
    scheduledTime: new Date(scheduledTime).toISOString(),
    ...stats,
  });
  return stats;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** How long a group takes if every check times out: rounds of MAX_CONCURRENT_CHECKS. */
function worstCaseMs(group: readonly ClaimedMonitor[]): number {
  const rounds = Math.ceil(group.length / MAX_CONCURRENT_CHECKS);
  return rounds * Math.max(...group.map((m) => m.timeoutMs));
}

function evaluate(monitor: ClaimedMonitor, result: CheckResult): EvaluatedCheck {
  const outcome: CheckOutcome = !result.success
    ? 'FAIL'
    : result.responseMs !== null && result.responseMs > monitor.latencyThresholdMs
      ? 'SLOW'
      : 'OK';
  const step = applyCheck(monitor.status, outcome);
  return {
    result,
    outcome,
    before: monitor.status,
    after: step.status,
    transition: step.transition,
    statusChanged: statusChanged(monitor.status, step.status),
  };
}

function latencySummary(results: readonly CheckResult[]): TickStats['latencyMs'] {
  const sorted = results
    .flatMap((r) => (r.responseMs === null ? [] : [r.responseMs]))
    .sort((a, b) => a - b);
  // Nearest-rank percentile.
  const at = (p: number) => sorted[Math.max(Math.ceil(p * sorted.length) - 1, 0)] ?? null;
  return { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null };
}

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}
