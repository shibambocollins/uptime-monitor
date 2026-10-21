import type { MonitorState, MonitorStatus } from '@uptime/core';

export interface ClaimedMonitor {
  id: number;
  url: string;
  timeoutMs: number;
  latencyThresholdMs: number;
  expectedStatus: number;
  status: MonitorStatus;
}

interface ClaimedRow {
  id: number;
  url: string;
  timeout_ms: number;
  latency_threshold_ms: number;
  expected_status: number;
  state: MonitorState;
  consecutive_failures: number;
  consecutive_slow: number;
  consecutive_successes: number;
}

/**
 * Claims up to `limit` due monitors in one statement and moves their next_run_at one
 * interval past `now`. That move is the lease: a tick that starts while this one is still
 * running no longer sees them as due. D1 runs statements one at a time, so two ticks can't
 * claim the same row.
 *
 * Pass the cron's scheduled time as `now`, not the clock: the next run then equals a later
 * tick's scheduled time exactly, and a tick that starts late or early doesn't push a check
 * into the following tick. Cloudflare does not schedule on the minute boundary: in
 * production every tick of this Worker was scheduled at the same offset (:45.457,
 * 2026-10-21), so the arithmetic stays aligned as long as that offset holds.
 *
 * One row written per claimed monitor. No index on next_run_at, so the inner SELECT scans
 * the table (rows read, not written; CLAUDE.md §5).
 */
const CLAIM_SQL = `
UPDATE monitors
SET next_run_at = ?1 + interval_seconds * 1000
WHERE id IN (
  SELECT id FROM monitors
  WHERE enabled = 1 AND next_run_at <= ?1
  ORDER BY next_run_at
  LIMIT ?2
)
RETURNING id, url, timeout_ms, latency_threshold_ms, expected_status,
  state, consecutive_failures, consecutive_slow, consecutive_successes`;

export async function claimDueMonitors(
  db: D1Database,
  now: number,
  limit: number,
): Promise<{ monitors: ClaimedMonitor[]; meta: D1Meta }> {
  const { results, meta } = await db.prepare(CLAIM_SQL).bind(now, limit).run<ClaimedRow>();
  return {
    monitors: results.map((row) => ({
      id: row.id,
      url: row.url,
      timeoutMs: row.timeout_ms,
      latencyThresholdMs: row.latency_threshold_ms,
      expectedStatus: row.expected_status,
      status: {
        state: row.state,
        consecutiveFailures: row.consecutive_failures,
        consecutiveSlow: row.consecutive_slow,
        consecutiveSuccesses: row.consecutive_successes,
      },
    })),
    meta,
  };
}
