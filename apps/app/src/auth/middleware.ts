import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { AppDeps, AppEnv } from '../app-env';
import { apiError } from '../http/errors';
import { findSession, SESSION_COOKIE } from './sessions';

/** Rejects the request with 401 unless it carries a live session; sets `c.var.user`. */
export const requireSession = (deps: AppDeps) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token ? await findSession(c.env.DB, token, deps.now()) : null;
    if (user === null) return apiError(c, 401, 'UNAUTHENTICATED', 'Sign in first.');
    c.set('user', user);
    await next();
  });
