import { applyCheck, type CheckOutcome, statusChanged, type Transition } from '@uptime/core';
import type { ClaimedMonitor } from './claim';
import { buildWriteStatements, type EvaluatedCheck } from './persist';
import { type CheckDeps, type CheckResult, runChecks } from './run-checks';

export interface GroupDeps extends CheckDeps {
  db: D1Database;
}

/** What one group reports back to the tick. Plain data, so it crosses the RPC boundary. */
export interface GroupResult {
  checkedIds: number[];
  failures: number;
  slow: number;
  transitions: ({ monitorId: number } & Transition)[];
  statements: number;
  rowsWritten: { rollup: number; monitor: number; event: number };
  rowsRead: number;
  /** Time to response headers, for checks that got a response. */
  latenciesMs: number[];
}

/**
 * Checks one group of monitors, applies the state machine and writes the group's results
 * in one db.batch(). Runs inside a CheckRunner invocation, so the CPU it costs (fetch()
 * calls, evaluation, statement building) counts against that invocation, not the tick.
 * The batch is atomic: either the whole group is recorded or none of it.
 */
export async function checkGroup(
  monitors: readonly ClaimedMonitor[],
  deps: GroupDeps,
): Promise<GroupResult> {
  const results = await runChecks(monitors, deps);
  const checks = monitors.map((monitor, i) => evaluate(monitor, results[i] as CheckResult));

  const { statements, kinds } = buildWriteStatements(deps.db, checks);
  const batch = statements.length > 0 ? await deps.db.batch(statements) : [];

  const rowsWritten = { rollup: 0, monitor: 0, event: 0 };
  let rowsRead = 0;
  batch.forEach((result, i) => {
    const kind = kinds[i];
    if (kind === 'rollup' || kind === 'monitor' || kind === 'event') {
      rowsWritten[kind] += result.meta.rows_written;
    }
    rowsRead += result.meta.rows_read;
  });

  return {
    checkedIds: checks.map((c) => c.result.monitorId),
    failures: checks.filter((c) => c.outcome === 'FAIL').length,
    slow: checks.filter((c) => c.outcome === 'SLOW').length,
    transitions: checks.flatMap((c) =>
      c.transition ? [{ monitorId: c.result.monitorId, ...c.transition }] : [],
    ),
    statements: statements.length,
    rowsWritten,
    rowsRead,
    latenciesMs: results.flatMap((r) => (r.responseMs === null ? [] : [r.responseMs])),
  };
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
