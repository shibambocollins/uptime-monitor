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

export type StatementKind = 'rollup' | 'monitor' | 'event' | 'alert' | 'release';

// The rollup and event inserts write nothing if the monitor was deleted while its check
// was in flight (the API deletes monitors). A plain INSERT would hit the foreign key and
// fail the whole batch, losing the other monitors' results in the group. The EXISTS is a
// primary-key lookup: one row read, no rows written. (SQLite needs a WHERE on an
// INSERT ... SELECT with an upsert clause anyway, to parse ON CONFLICT unambiguously.)
const ROLLUP_SQL = `
INSERT INTO check_rollups_hourly
  (monitor_id, hour, total, failures, latency_sum_ms,
   lt_250, lt_500, lt_1000, lt_2500, lt_5000, ge_5000)
SELECT ?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
WHERE EXISTS (SELECT 1 FROM monitors WHERE id = ?1)
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

/**
 * A monitor part-way to a state change is checked again at the next tick, not a whole
 * interval later: failures counting towards DOWN (an outage is confirmed in about 2 minutes
 * instead of 10-15), and, once DOWN, successes counting towards UP (a recovery is confirmed
 * about a minute after the first good check, not a whole interval later).
 * Half a tick, so it is due when the next tick claims (ticks are a minute apart). Costs no
 * extra row: the monitor row is rewritten anyway, because one of its counters changed.
 */
export const RECHECK_MS = 30_000;

/** When to check again early, or null for the normal interval (set by the claim). */
function recheckAt(after: MonitorStatus, checkedAt: number): number | null {
  const counting =
    after.state === 'DOWN' ? after.consecutiveSuccesses > 0 : after.consecutiveFailures > 0;
  return counting ? checkedAt + RECHECK_MS : null;
}

// ?6: when to re-check early, or NULL for the normal interval (set by the claim). MIN, so an
// early re-check never pushes a check later.
const MONITOR_SQL = `
UPDATE monitors
SET state = ?2, consecutive_failures = ?3, consecutive_slow = ?4, consecutive_successes = ?5,
  next_run_at = CASE WHEN ?6 IS NULL THEN next_run_at ELSE MIN(next_run_at, ?6) END
WHERE id = ?1`;

const EVENT_SQL = `
INSERT INTO check_events
  (monitor_id, checked_at, success, status_code, response_ms, error, state)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
WHERE EXISTS (SELECT 1 FROM monitors WHERE id = ?1)`;

// Incidents and the alert outbox (migrations/0003_alerts.sql). Only on a transition into
// or out of DOWN, so a steady check never runs these.

/** Closes the monitor's open incident, if any. */
const CLOSE_INCIDENT_SQL = `
UPDATE incidents SET resolved_at = ?2 WHERE monitor_id = ?1 AND resolved_at IS NULL`;

const OPEN_INCIDENT_SQL = `
INSERT INTO incidents (monitor_id, started_at, cause)
SELECT ?1, ?2, ?3
WHERE EXISTS (SELECT 1 FROM monitors WHERE id = ?1)`;

/** The alert for the open incident. ON CONFLICT: one of each type per incident. */
const ALERT_EVENT_SQL = `
INSERT INTO alert_events (monitor_id, incident_id, type, created_at)
SELECT ?1, id, ?3, ?2 FROM incidents WHERE monitor_id = ?1 AND resolved_at IS NULL
ON CONFLICT DO NOTHING`;

/**
 * Queues that alert for every enabled, working channel of the monitor's team, due now.
 * Ids are found by joins rather than last_insert_rowid(), which keeps its old value when
 * an INSERT ... SELECT inserts nothing.
 */
const ALERT_DELIVERIES_SQL = `
INSERT INTO alert_deliveries (event_id, channel_id, next_attempt_at)
SELECT e.id, c.id, ?2
FROM incidents AS i
JOIN alert_events AS e ON e.incident_id = i.id AND e.type = ?3
JOIN monitors AS m ON m.id = i.monitor_id
JOIN projects AS p ON p.id = m.project_id
JOIN notification_channels AS c
  ON c.team_id = p.team_id AND c.enabled = 1 AND c.broken_at IS NULL
WHERE i.monitor_id = ?1 AND i.resolved_at IS NULL
ON CONFLICT DO NOTHING`;

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
 * failure or a state change; incident and alert rows only when the monitor
 * goes DOWN or comes back from DOWN (one alert on open, one on recovery).
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
            recheckAt(after, result.checkedAt),
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
    for (const statement of alertStatements(db, check)) add('alert', statement);
  }
  return { statements, kinds };
}

function alertStatements(db: D1Database, check: EvaluatedCheck): D1PreparedStatement[] {
  const { transition, result } = check;
  if (!transition) return [];
  const { monitorId, checkedAt } = result;
  const queue = (type: 'DOWN' | 'RECOVERED') => [
    db.prepare(ALERT_EVENT_SQL).bind(monitorId, checkedAt, type),
    db.prepare(ALERT_DELIVERIES_SQL).bind(monitorId, checkedAt, type),
  ];

  if (transition.to === 'DOWN') {
    return [
      // An incident left open (say, by a URL change that reset the state) is closed first,
      // so the new one can open: incidents_open allows one open incident per monitor.
      db.prepare(CLOSE_INCIDENT_SQL).bind(monitorId, checkedAt),
      db.prepare(OPEN_INCIDENT_SQL).bind(monitorId, checkedAt, result.error),
      ...queue('DOWN'),
    ];
  }
  if (transition.from === 'DOWN') {
    // The RECOVERED alert is queued while the incident is still open, then it is closed.
    return [...queue('RECOVERED'), db.prepare(CLOSE_INCIDENT_SQL).bind(monitorId, checkedAt)];
  }
  return []; // UP <-> DEGRADED: no incident (a SLOW alert would come with alert_rules)
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
