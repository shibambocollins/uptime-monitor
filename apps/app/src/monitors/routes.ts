import { MAX_URL_LENGTH, type UrlCheck, validateMonitorUrl } from '@uptime/core';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps, AppEnv } from '../app-env';
import { apiError, notFound, readOnly } from '../http/errors';
import { parseId, parseJsonBody } from '../http/validate';
import {
  canWrite,
  findMonitor,
  findProject,
  MONITOR_COLUMNS,
  type MonitorRow,
} from '../teams/access';

/**
 * Monitors per team, across its live projects. The write budget is the binding limit
 * (CLAUDE.md §5): at 2 rows per check and 5-minute intervals one monitor writes 576 rows a
 * day, so 20 monitors use about 12% of the 100,000-row cap. Raise it with that in mind.
 */
export const MAX_MONITORS_PER_TEAM = 20;
/** CLAUDE.md §5: default and minimum interval 5 minutes. */
export const MIN_INTERVAL_SECONDS = 300;

const fields = {
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().min(1).max(MAX_URL_LENGTH),
  intervalSeconds: z.int().min(MIN_INTERVAL_SECONDS).max(86_400),
  // At most 20 s: a tick must finish its groups inside 50 s (checker/tick.ts).
  timeoutMs: z.int().min(1_000).max(20_000),
  latencyThresholdMs: z.int().min(1).max(60_000),
  expectedStatus: z.int().min(100).max(599),
  enabled: z.boolean(),
};

const CreateMonitor = z.strictObject({
  name: fields.name,
  url: fields.url,
  intervalSeconds: fields.intervalSeconds.default(MIN_INTERVAL_SECONDS),
  timeoutMs: fields.timeoutMs.default(10_000),
  latencyThresholdMs: fields.latencyThresholdMs.default(2_000),
  expectedStatus: fields.expectedStatus.default(200),
  enabled: fields.enabled.default(true),
});

const UpdateMonitor = z
  .strictObject(fields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change.');

/** Request field → column. Only these names ever reach the SQL text. */
const COLUMN = {
  name: 'name',
  url: 'url',
  intervalSeconds: 'interval_seconds',
  timeoutMs: 'timeout_ms',
  latencyThresholdMs: 'latency_threshold_ms',
  expectedStatus: 'expected_status',
  enabled: 'enabled',
} as const;

/** The monitor DTO: never the row itself (CLAUDE.md §12). */
export const monitorDto = (row: MonitorRow) => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  url: row.url,
  intervalSeconds: row.interval_seconds,
  timeoutMs: row.timeout_ms,
  latencyThresholdMs: row.latency_threshold_ms,
  expectedStatus: row.expected_status,
  enabled: row.enabled === 1,
  state: row.state,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Mounted at /api/v1 behind requireSession (app.ts). */
export function monitorRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>();

  routes.get('/projects/:projectId/monitors', async (c) => {
    const projectId = parseId(c.req.param('projectId'));
    const project =
      projectId === null ? null : await findProject(c.env.DB, c.var.user.userId, projectId);
    if (!project) return notFound(c);
    const { results } = await c.env.DB.prepare(
      `SELECT ${MONITOR_COLUMNS} FROM monitors WHERE project_id = ?1 ORDER BY id`,
    )
      .bind(project.id)
      .all<MonitorRow>();
    return c.json({ monitors: results.map(monitorDto) });
  });

  routes.post('/projects/:projectId/monitors', async (c) => {
    const projectId = parseId(c.req.param('projectId'));
    const project =
      projectId === null ? null : await findProject(c.env.DB, c.var.user.userId, projectId);
    if (!project) return notFound(c);
    if (!canWrite(project.role)) return readOnly(c);

    const body = await parseJsonBody(c, CreateMonitor);
    if (!body.ok) return body.response;
    const url = validateMonitorUrl(body.data.url);
    if (!url.ok) return urlRejected(c, url);

    // One statement, so the cap and "the project is still live" hold even with requests
    // racing (D1 runs one statement at a time). next_run_at 0: checked on the next tick.
    // 2 rows written: the row and its project_id index.
    const now = deps.now();
    const m = body.data;
    const row = await c.env.DB.prepare(
      `INSERT INTO monitors (project_id, name, url, interval_seconds, timeout_ms,
         latency_threshold_ms, expected_status, enabled, next_run_at, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9
       WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?1 AND deleted_at IS NULL)
         AND (SELECT count(*) FROM monitors AS mo
              JOIN projects AS p ON p.id = mo.project_id
              WHERE p.team_id = ?10 AND p.deleted_at IS NULL) < ?11
       RETURNING ${MONITOR_COLUMNS}`,
    )
      .bind(
        project.id,
        m.name,
        url.href,
        m.intervalSeconds,
        m.timeoutMs,
        m.latencyThresholdMs,
        m.expectedStatus,
        m.enabled ? 1 : 0,
        now,
        project.team_id,
        MAX_MONITORS_PER_TEAM,
      )
      .first<MonitorRow>();
    if (row === null) {
      // Either the cap, or the project was deleted after we looked it up.
      if (!(await findProject(c.env.DB, c.var.user.userId, project.id))) return notFound(c);
      return apiError(
        c,
        409,
        'LIMIT_REACHED',
        `A team can have at most ${MAX_MONITORS_PER_TEAM} monitors.`,
      );
    }
    // No URL in the log: query strings can carry tokens (CLAUDE.md §8).
    console.log({
      event: 'monitor_created',
      monitorId: row.id,
      projectId: project.id,
      teamId: project.team_id,
      userId: c.var.user.userId,
    });
    return c.json({ monitor: monitorDto(row) }, 201);
  });

  routes.get('/monitors/:monitorId', async (c) => {
    const monitor = await loadMonitor(c);
    return monitor ? c.json({ monitor: monitorDto(monitor) }) : notFound(c);
  });

  routes.patch('/monitors/:monitorId', async (c) => {
    const monitor = await loadMonitor(c);
    if (!monitor) return notFound(c);
    if (!canWrite(monitor.role)) return readOnly(c);

    const body = await parseJsonBody(c, UpdateMonitor);
    if (!body.ok) return body.response;

    const changes: Partial<Record<keyof typeof COLUMN, string | number>> = {};
    for (const [field, value] of Object.entries(body.data) as [keyof typeof COLUMN, unknown][]) {
      if (value === undefined) continue;
      changes[field] = typeof value === 'boolean' ? (value ? 1 : 0) : (value as string | number);
    }

    const extra: string[] = [];
    if (body.data.url !== undefined) {
      const url = validateMonitorUrl(body.data.url);
      if (!url.ok) return urlRejected(c, url);
      changes.url = url.href;
      // A new target: the old state and streaks describe a different site, so start over
      // and check it on the next tick. (A check of the old URL already in flight can still
      // write its state afterwards; it is corrected by the following checks.)
      if (url.href !== monitor.url) {
        extra.push(
          `state = 'UP'`,
          `consecutive_failures = 0`,
          `consecutive_slow = 0`,
          `consecutive_successes = 0`,
          `next_run_at = 0`,
        );
      }
    }
    // Switched back on: check it on the next tick rather than at a stale next_run_at.
    if (body.data.enabled === true && monitor.enabled === 0 && !extra.length) {
      extra.push(`next_run_at = 0`);
    }

    const entries = Object.entries(changes) as [keyof typeof COLUMN, string | number][];
    const sets = entries.map(([field], i) => `${COLUMN[field]} = ?${i + 3}`);
    // One row written; project_id never changes here, so its index isn't touched.
    const row = await c.env.DB.prepare(
      `UPDATE monitors SET ${[...sets, ...extra, 'updated_at = ?2'].join(', ')}
       WHERE id = ?1 RETURNING ${MONITOR_COLUMNS}`,
    )
      .bind(monitor.id, deps.now(), ...entries.map(([, value]) => value))
      .first<MonitorRow>();
    return row ? c.json({ monitor: monitorDto(row) }) : notFound(c);
  });

  /**
   * Hard delete: its rollups and events go with it (ON DELETE CASCADE, both indexed on
   * monitor_id). A check already in flight for it then finds no monitor and writes nothing
   * (checker/persist.ts).
   */
  routes.delete('/monitors/:monitorId', async (c) => {
    const monitor = await loadMonitor(c);
    if (!monitor) return notFound(c);
    if (!canWrite(monitor.role)) return readOnly(c);
    await c.env.DB.prepare(`DELETE FROM monitors WHERE id = ?1`).bind(monitor.id).run();
    console.log({
      event: 'monitor_deleted',
      monitorId: monitor.id,
      teamId: monitor.team_id,
      userId: c.var.user.userId,
    });
    return c.body(null, 204);
  });

  return routes;
}

async function loadMonitor(c: Context<AppEnv>) {
  const monitorId = parseId(c.req.param('monitorId'));
  return monitorId === null ? null : findMonitor(c.env.DB, c.var.user.userId, monitorId);
}

const URL_MESSAGES: Record<Exclude<UrlCheck, { ok: true }>['reason'], string> = {
  INVALID_URL: 'This is not a valid URL.',
  TOO_LONG: `URLs can be at most ${MAX_URL_LENGTH} characters.`,
  UNSUPPORTED_SCHEME: 'Only http and https URLs can be monitored.',
  CREDENTIALS: 'Remove the username and password from the URL.',
  INTERNAL_HOSTNAME: 'This hostname only exists inside private networks.',
  BLOCKED_ADDRESS: 'This address is private or reserved, so it cannot be monitored.',
};

/** SSRF rules (CLAUDE.md §8): the reason is safe to show; it only describes the input. */
function urlRejected(c: Context, check: Exclude<UrlCheck, { ok: true }>) {
  const message = URL_MESSAGES[check.reason];
  return apiError(c, 400, 'URL_NOT_ALLOWED', message, [{ field: 'url', message }]);
}
