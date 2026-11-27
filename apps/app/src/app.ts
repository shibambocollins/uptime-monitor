import { Hono } from 'hono';
import type { AppDeps, AppEnv } from './app-env';
import { requireSession } from './auth/middleware';
import { authRoutes } from './auth/routes';
import { channelRoutes } from './channels/routes';
import { apiError } from './http/errors';
import { rateLimit } from './http/rate-limit';
import { monitorRoutes } from './monitors/routes';
import { projectRoutes } from './projects/routes';
import { statusRoutes } from './status/routes';

/** The /api/v1 app. Everything else is static assets (wrangler.jsonc "assets"). */
export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get('/api/v1/health', (c) => c.json({ status: 'ok' }));

  app.route('/api/v1/auth', authRoutes(deps));

  // Everything under these prefixes needs a session. Registered here, once, rather than
  // inside the routers: a router's own middleware would also run for /api/v1/health and
  // /api/v1/auth once mounted at /api/v1, and two routers would look the session up twice.
  // Writes are rate-limited per user after the session check (reads only cost rows read).
  const session = requireSession(deps);
  const writeLimit = rateLimit(deps, 'write', (c) => `user:${c.var.user.userId}`);
  const prefixes = ['/teams/*', '/projects/*', '/monitors/*', '/channels/*'];
  for (const prefix of prefixes.map((p) => `/api/v1${p}`)) {
    app.use(prefix, session);
    app.use(prefix, (c, next) =>
      c.req.method === 'GET' || c.req.method === 'HEAD' ? next() : writeLimit(c, next),
    );
  }
  app.route('/api/v1', projectRoutes(deps));
  app.route('/api/v1', monitorRoutes(deps));
  app.route('/api/v1', channelRoutes(deps));
  app.route('/api/v1', statusRoutes(deps));

  /** The signed-in user and their teams. A DTO, not database rows (CLAUDE.md §12). */
  app.get('/api/v1/me', requireSession(deps), async (c) => {
    const user = c.var.user;
    const { results: teams } = await c.env.DB.prepare(
      `SELECT t.id, t.name, m.role
       FROM team_members AS m JOIN teams AS t ON t.id = m.team_id
       WHERE m.user_id = ?1 ORDER BY t.id`,
    )
      .bind(user.userId)
      .all<{ id: number; name: string; role: string }>();
    return c.json({
      user: { id: user.userId, login: user.login, name: user.name, avatarUrl: user.avatarUrl },
      teams,
    });
  });

  // Only /api/* reaches the Worker (run_worker_first), so these are API answers.
  app.notFound((c) => apiError(c, 404, 'NOT_FOUND', 'No such endpoint.'));
  app.onError((error, c) => {
    console.error({ event: 'unhandled_error', path: c.req.path, error: String(error) });
    return apiError(c, 500, 'INTERNAL', 'Something went wrong.');
  });

  return app;
}
