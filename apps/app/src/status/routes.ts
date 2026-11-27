import { Hono } from 'hono';
import type { AppEnv } from '../app-env';
import { notFound } from '../http/errors';
import { parseId } from '../http/validate';
import { teamRole } from '../teams/access';

// What the dashboard shows next to each monitor, in one read for the whole team:
// uptime and latency over 24 hours (from the hourly rollups, CLAUDE.md §5), the last check,
// and recent incidents. Reads only: about 20 monitors × 25 rollup rows per call.

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
/** How many incidents the dashboard lists. */
export const RECENT_INCIDENTS = 10;

interface MonitorStatsRow {
  id: number;
  interval_seconds: number;
  next_run_at: number;
  last_event_at: number | null;
  total: number | null;
  failures: number | null;
  latency_sum_ms: number | null;
  open_since: number | null;
}

interface IncidentRow {
  id: number;
  monitor_id: number;
  monitor_name: string;
  started_at: number;
  resolved_at: number | null;
  cause: string | null;
}

/**
 * There is no last_checked_at column (CLAUDE.md §10). The claim moves next_run_at one
 * interval ahead, so a normal check was one interval before it; 0 means "due now" (never
 * checked, or reset by a URL change). A failure re-checked early (FAILURE_RECHECK_MS) breaks
 * that sum, but every failure is stored as an event, so the later of the two is right.
 */
function lastChecked(row: MonitorStatsRow): number | null {
  const fromClaim = row.next_run_at > 0 ? row.next_run_at - row.interval_seconds * 1000 : null;
  if (fromClaim === null) return row.last_event_at;
  return Math.max(fromClaim, row.last_event_at ?? 0);
}

/** Mounted at /api/v1 behind requireSession (app.ts). */
export function statusRoutes(deps: { now: () => number }) {
  const routes = new Hono<AppEnv>();

  routes.get('/teams/:teamId/status', async (c) => {
    const teamId = parseId(c.req.param('teamId'));
    if (teamId === null || (await teamRole(c.env.DB, c.var.user.userId, teamId)) === null) {
      return notFound(c);
    }
    // The rollup for the current hour is partial, so "24 hours" is the last 24 full hours
    // plus the current one: at most 25 rows per monitor.
    const since = Math.floor((deps.now() - DAY_MS) / HOUR_MS) * HOUR_MS;
    const [monitors, incidents] = (await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT mo.id, mo.interval_seconds, mo.next_run_at,
           (SELECT MAX(ev.checked_at) FROM check_events AS ev
            WHERE ev.monitor_id = mo.id) AS last_event_at,
           SUM(r.total) AS total, SUM(r.failures) AS failures,
           SUM(r.latency_sum_ms) AS latency_sum_ms,
           (SELECT i.started_at FROM incidents AS i
            WHERE i.monitor_id = mo.id AND i.resolved_at IS NULL) AS open_since
         FROM monitors AS mo
         JOIN projects AS p ON p.id = mo.project_id AND p.deleted_at IS NULL
         LEFT JOIN check_rollups_hourly AS r ON r.monitor_id = mo.id AND r.hour >= ?2
         WHERE p.team_id = ?1
         GROUP BY mo.id ORDER BY mo.id`,
      ).bind(teamId, since),
      c.env.DB.prepare(
        `SELECT i.id, i.monitor_id, mo.name AS monitor_name, i.started_at, i.resolved_at, i.cause
         FROM incidents AS i
         JOIN monitors AS mo ON mo.id = i.monitor_id
         JOIN projects AS p ON p.id = mo.project_id AND p.deleted_at IS NULL
         WHERE p.team_id = ?1
         ORDER BY i.started_at DESC LIMIT ?2`,
      ).bind(teamId, RECENT_INCIDENTS),
    ])) as [D1Result, D1Result];

    return c.json({
      monitors: (monitors.results as unknown as MonitorStatsRow[]).map((row) => {
        const total = row.total ?? 0;
        return {
          monitorId: row.id,
          lastCheckedAt: lastChecked(row),
          checks24h: total,
          uptime24h: total > 0 ? (total - (row.failures ?? 0)) / total : null,
          avgLatencyMs24h: total > 0 ? Math.round((row.latency_sum_ms ?? 0) / total) : null,
          downSince: row.open_since,
        };
      }),
      incidents: (incidents.results as unknown as IncidentRow[]).map((row) => ({
        id: row.id,
        monitorId: row.monitor_id,
        monitorName: row.monitor_name,
        startedAt: row.started_at,
        resolvedAt: row.resolved_at,
        cause: row.cause,
      })),
    });
  });

  return routes;
}
