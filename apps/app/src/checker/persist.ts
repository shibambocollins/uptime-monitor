import type { CheckOutcome, MonitorStatus, Transition } from '@uptime/core';
import type { CheckResult } from './run-checks';

export const HOUR_MS = 3_600_000;

/** Upper bounds (exclusive) of the latency buckets; the last bucket is everything above. */
export const LATENCY_BUCKETS_MS = [250, 500, 1000, 2500, 5000] as const;

export interface EvaluatedCheck {
  result: CheckResult;
  outcome: CheckOutcome;
  before: MonitorStatus;
  after: MonitorStatus;
  transition: Transition | null;
  statusChanged: boolean;
}

export type StatementKind = 'rollup' | 'monitor' | 'event' | 'release';

const ROLLUP_SQL = `
INSERT INTO check_rollups_hourly
  (monitor_id, hour, total, failures, latency_sum_ms,
   lt_250, lt_500, lt_1000, lt_2500, lt_5000, ge_5000)
VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
ON CONFLICT (monitor_id, hour) DO UPDATE SET
  total = total + 1,
  failures = failures + excluded.failures,
  latency_sum_ms = latency_sum_ms + excluded.latency_sum_ms,
  lt_250 = lt_250 + excluded.lt_250,
  lt_500 = lt_500 + excluded.lt_500,
  lt_1000 = lt_1000 + excluded.lt_1000,
  lt_2500 = lt_2500 + excluded.lt_2500,
  lt_5000 = lt_5000 + excluded.lt_5000,
  ge_5000 = ge_5000 + excluded.ge_5000`;

const MONITOR_SQL = `
UPDATE monitors
SET state = ?2, consecutive_failures = ?3, consecutive_slow = ?4, consecutive_successes = ?5
WHERE id = ?1`;

const EVENT_SQL = `
INSERT INTO check_events
  (monitor_id, checked_at, success, status_code, response_ms, error, state)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;

const RELEASE_SQL = `
UPDATE monitors SET next_run_at = ?1
WHERE id IN (SELECT value FROM json_each(?2))`;

/**
 * Hands claimed-but-unchecked monitors back by making them due at `dueAt`, so the next tick
 * picks them up instead of them waiting a whole interval. One row written per monitor.
 */
export function releaseStatement(
  db: D1Database,
  monitorIds: readonly number[],
  dueAt: number,
): D1PreparedStatement {
  return db.prepare(RELEASE_SQL).bind(dueAt, JSON.stringify(monitorIds));
}

/**
 * Every write for one tick, to be sent as a single db.batch(). Per check: one rollup
 * upsert always; the monitor row only if its status changed; a raw event only for a
 * failure or a state change (CLAUDE.md §5).
 */
export function buildWriteStatements(
  db: D1Database,
  checks: readonly EvaluatedCheck[],
): { statements: D1PreparedStatement[]; kinds: StatementKind[] } {
  const statements: D1PreparedStatement[] = [];
  const kinds: StatementKind[] = [];
  const add = (kind: StatementKind, statement: D1PreparedStatement) => {
    statements.push(statement);
    kinds.push(kind);
  };

  for (const check of checks) {
    const { result, after } = check;
    add('rollup', db.prepare(ROLLUP_SQL).bind(...rollupValues(result)));
    if (check.statusChanged) {
      add(
        'monitor',
        db
          .prepare(MONITOR_SQL)
          .bind(
            result.monitorId,
            after.state,
            after.consecutiveFailures,
            after.consecutiveSlow,
            after.consecutiveSuccesses,
          ),
      );
    }
    if (!result.success || check.transition) {
      add(
        'event',
        db
          .prepare(EVENT_SQL)
          .bind(
            result.monitorId,
            result.checkedAt,
            result.success ? 1 : 0,
            result.statusCode,
            result.responseMs,
            result.error,
            after.state,
          ),
      );
    }
  }
  return { statements, kinds };
}

function rollupValues(result: CheckResult): number[] {
  const buckets = new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0);
  if (result.responseMs !== null) buckets[latencyBucket(result.responseMs)] = 1;
  return [
    result.monitorId,
    Math.floor(result.checkedAt / HOUR_MS) * HOUR_MS,
    result.success ? 0 : 1,
    result.responseMs ?? 0,
    ...buckets,
  ];
}

export function latencyBucket(responseMs: number): number {
  const index = LATENCY_BUCKETS_MS.findIndex((bound) => responseMs < bound);
  return index === -1 ? LATENCY_BUCKETS_MS.length : index;
}
