import { applyCheck, type CheckOutcome, statusChanged } from '@uptime/core';
import { type ClaimedMonitor, claimDueMonitors } from './claim';
import { buildWriteStatements, type EvaluatedCheck, type StatementKind } from './persist';
import { type CheckDeps, type CheckResult, runChecks } from './run-checks';

/**
 * Never more than this, whatever MAX_CHECKS_PER_TICK says: 50 subrequests per invocation
 * on the free plan, minus room for D1 and alert calls (CLAUDE.md §5). The CPU limit keeps
 * the real setting much lower (wrangler.jsonc).
 */
export const HARD_MAX_CHECKS_PER_TICK = 40;

export interface TickDeps extends CheckDeps {
  db: D1Database;
  sleep: (ms: number) => Promise<void>;
  log: (entry: Record<string, unknown>) => void;
  tickId: string;
  maxChecks: number;
  /** SPIKE (Phase 0 P6): pause before writing results. */
  slowTickMs: number;
}

export interface TickStats {
  claimed: number;
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
 * One cron tick: claim due monitors, check them, write everything in one batch, record
 * usage, log one line. Three D1 calls per tick: claim, batch, usage.
 */
export async function runTick(scheduledTime: number, deps: TickDeps): Promise<TickStats> {
  const startedAt = deps.now();
  const limit = Math.min(Math.max(deps.maxChecks, 1), HARD_MAX_CHECKS_PER_TICK);

  const claim = await claimDueMonitors(deps.db, scheduledTime, limit);
  const results = await runChecks(claim.monitors, deps);
  if (deps.slowTickMs > 0) await deps.sleep(deps.slowTickMs);

  const checks = claim.monitors.map((monitor, i) => evaluate(monitor, results[i] as CheckResult));
  const { statements, kinds } = buildWriteStatements(deps.db, checks);
  const batch = statements.length > 0 ? await deps.db.batch(statements) : [];

  const rowsWritten = { claim: claim.meta.rows_written, rollup: 0, monitor: 0, event: 0, total: 0 };
  let rowsRead = claim.meta.rows_read;
  batch.forEach((result, i) => {
    rowsWritten[kinds[i] as StatementKind] += result.meta.rows_written;
    rowsRead += result.meta.rows_read;
  });
  rowsWritten.total =
    rowsWritten.claim + rowsWritten.rollup + rowsWritten.monitor + rowsWritten.event;

  await deps.db
    .prepare(USAGE_SQL)
    .bind(utcDay(scheduledTime), checks.length, rowsWritten.total, rowsRead)
    .run();

  const stats: TickStats = {
    claimed: checks.length,
    failures: checks.filter((c) => c.outcome === 'FAIL').length,
    slow: checks.filter((c) => c.outcome === 'SLOW').length,
    transitions: checks.flatMap((c) =>
      c.transition ? [{ monitorId: c.result.monitorId, ...c.transition }] : [],
    ),
    statements: statements.length,
    rowsWritten,
    rowsRead,
    latencyMs: latencySummary(results),
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
