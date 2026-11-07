import { type ClaimedMonitor, claimDueMonitors } from './claim';
import type { GroupResult } from './group';
import { releaseStatement, type StatementKind } from './persist';
import { MAX_CONCURRENT_CHECKS } from './run-checks';

/**
 * Never more than this, whatever MAX_CHECKS_PER_TICK says. A request chain allows 32
 * invocations, and the tick deadline caps the real number well below this.
 */
export const HARD_MAX_CHECKS_PER_TICK = 200;

/**
 * Checks per CheckRunner call. Each check costs a runner about 0.3-0.5 ms of CPU (fetch(),
 * evaluation, its share of the batch). With 10 per group, runners measured p50 4 ms but up
 * to 11 ms (Phase 0, 2026-11-07); 8 leaves headroom under the 10 ms limit.
 */
export const CHECKS_PER_GROUP = 8;

/**
 * A group only starts if it would finish, even if every check in it timed out, within this
 * long after the tick started. Keeping ticks under a minute means a 60 s monitor can't be
 * claimed again while the tick that claimed it is still running (the lease only holds
 * while the interval is longer than the tick). The first group always runs, so a group of
 * monitors with very long timeouts can still overrun; keep timeouts at 20 s or less.
 */
export const TICK_DEADLINE_MS = 50_000;

/**
 * Checks and records one group in a separate invocation (CheckRunner.checkGroup through
 * ctx.exports).
 */
export type RunGroup = (monitors: ClaimedMonitor[]) => Promise<GroupResult>;

export interface TickDeps {
  db: D1Database;
  runGroup: RunGroup;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
  tickId: string;
  maxChecks: number;
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
 * One cron tick, kept to dispatching so its own CPU stays near idle cost: claim due
 * monitors, hand them to CheckRunner in groups of CHECKS_PER_GROUP (one group at a time;
 * each group checks, evaluates and writes its own results), release what wasn't checked,
 * record usage, log one line. D1 calls: claim, one batch per group (made by the runners),
 * a release if needed, usage.
 */
export async function runTick(scheduledTime: number, deps: TickDeps): Promise<TickStats> {
  const startedAt = deps.now();
  const deadline = startedAt + (deps.deadlineMs ?? TICK_DEADLINE_MS);
  const limit = Math.min(Math.max(deps.maxChecks, 1), HARD_MAX_CHECKS_PER_TICK);

  const claim = await claimDueMonitors(deps.db, scheduledTime, limit);

  const groupResults: GroupResult[] = [];
  let groups = 0;
  let runnerErrors = 0;
  for (const [index, group] of chunk(claim.monitors, CHECKS_PER_GROUP).entries()) {
    if (index > 0 && deps.now() + worstCaseMs(group) > deadline) break;
    groups++;
    try {
      groupResults.push(await deps.runGroup(group));
    } catch (error) {
      // The runner failing says nothing about the monitors, so they are released, not failed.
      // Its batch is atomic, so a runner that failed before writing left nothing behind.
      runnerErrors++;
      deps.log({ event: 'runner_failed', tickId: deps.tickId, error: String(error) });
    }
  }

  const checkedIds = new Set(groupResults.flatMap((g) => g.checkedIds));
  const unchecked = claim.monitors.filter((monitor) => !checkedIds.has(monitor.id));

  const rowsWritten = {
    claim: claim.meta.rows_written,
    rollup: sum(groupResults, (g) => g.rowsWritten.rollup),
    monitor: sum(groupResults, (g) => g.rowsWritten.monitor),
    event: sum(groupResults, (g) => g.rowsWritten.event),
    release: 0,
    total: 0,
  };
  let rowsRead = claim.meta.rows_read + sum(groupResults, (g) => g.rowsRead);
  if (unchecked.length > 0) {
    const release = await releaseStatement(
      deps.db,
      unchecked.map((m) => m.id),
      scheduledTime,
    ).run();
    rowsWritten.release = release.meta.rows_written;
    rowsRead += release.meta.rows_read;
  }
  rowsWritten.total =
    rowsWritten.claim +
    rowsWritten.rollup +
    rowsWritten.monitor +
    rowsWritten.event +
    rowsWritten.release;

  await deps.db
    .prepare(USAGE_SQL)
    .bind(utcDay(scheduledTime), checkedIds.size, rowsWritten.total, rowsRead)
    .run();

  const stats: TickStats = {
    claimed: claim.monitors.length,
    checked: checkedIds.size,
    released: unchecked.length,
    groups,
    runnerErrors,
    failures: sum(groupResults, (g) => g.failures),
    slow: sum(groupResults, (g) => g.slow),
    transitions: groupResults.flatMap((g) => g.transitions),
    statements: sum(groupResults, (g) => g.statements),
    rowsWritten,
    rowsRead,
    latencyMs: latencySummary(groupResults.flatMap((g) => g.latenciesMs)),
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

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function latencySummary(latenciesMs: readonly number[]): TickStats['latencyMs'] {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  // Nearest-rank percentile.
  const at = (p: number) => sorted[Math.max(Math.ceil(p * sorted.length) - 1, 0)] ?? null;
  return { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null };
}

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}
