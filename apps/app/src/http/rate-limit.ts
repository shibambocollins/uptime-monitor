import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppDeps, AppEnv } from '../app-env';
import { apiError } from './errors';

/** One per Rate Limiting binding in wrangler.jsonc (limits and periods are set there). */
export type Bucket = 'login' | 'write';

/** True if the request may go ahead. Passed in (AppDeps) so tests can control it. */
export type RateLimitFn = (env: Env, bucket: Bucket, key: string) => Promise<boolean>;

const BINDING = { login: 'LOGIN_LIMITER', write: 'WRITE_LIMITER' } as const;

/** The production limiter: Cloudflare's Rate Limiting bindings. */
export const bindingRateLimit: RateLimitFn = async (env, bucket, key) =>
  (await env[BINDING[bucket]].limit({ key })).success;

/**
 * Answers 429 once `key(c)` has used up its allowance. If the limiter itself fails, the
 * request goes ahead and the failure is logged: this guards against abuse, the per-team
 * caps still hold, and an outage of the limiter shouldn't take sign-in down with it.
 */
export const rateLimit = (deps: AppDeps, bucket: Bucket, key: (c: Context<AppEnv>) => string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    let allowed = true;
    try {
      allowed = await deps.rateLimit(c.env, bucket, key(c));
    } catch (error) {
      console.error({ event: 'rate_limit_error', bucket, error: String(error) });
    }
    if (!allowed) {
      console.log({ event: 'rate_limited', bucket, path: c.req.path });
      // Both limits use a 60-second window.
      c.header('Retry-After', '60');
      return apiError(c, 429, 'RATE_LIMITED', 'Too many requests. Wait a minute and try again.');
    }
    await next();
  });

/**
 * The client's IP as Cloudflare saw it. Set by Cloudflare's edge on every request, so
 * a client can't choose it. Not logged: an IP is personal data (POPIA).
 */
export const clientIp = (c: Context) => c.req.header('CF-Connecting-IP') ?? 'unknown';
