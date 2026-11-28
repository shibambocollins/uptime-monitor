import type { FetchFn } from './checker/run-checks';
import type { SessionUser } from './auth/sessions';
import type { RateLimitFn } from './http/rate-limit';
import type { CheckHostFn } from './monitors/dns';

/** Hono's type parameter for every route: bindings, plus what middleware sets. */
export interface AppEnv {
  Bindings: Env;
  Variables: { user: SessionUser };
}

/** Outside effects the API needs, passed in so tests can fake them. */
export interface AppDeps {
  fetch: FetchFn;
  now: () => number;
  rateLimit: RateLimitFn;
  /** DNS check for monitor hostnames (monitors/dns.ts). */
  checkHost: CheckHostFn;
}
