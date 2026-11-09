import type { FetchFn } from './checker/run-checks';
import type { SessionUser } from './auth/sessions';

/** Hono's type parameter for every route: bindings, plus what middleware sets. */
export interface AppEnv {
  Bindings: Env;
  Variables: { user: SessionUser };
}

/** Outside effects the API needs, passed in so tests can fake them (CLAUDE.md §12). */
export interface AppDeps {
  fetch: FetchFn;
  now: () => number;
}
