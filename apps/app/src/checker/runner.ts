import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ClaimedMonitor } from './claim';
import { type CheckResult, runChecks } from './run-checks';

/**
 * Runs one group of checks in its own invocation. The cron tick calls it through
 * ctx.exports (on by default from compatibility date 2025-11-17), one group at a time.
 *
 * Why (Phase 0, 2026-10-21): each fetch() costs about 0.25-0.45 ms of CPU, so one
 * invocation fits about 10 checks inside the free plan's 10 ms. Each call here is a
 * separate invocation with its own CPU time and its own subrequest count. The 6-connection
 * limit is shared by the whole chain, so the caller must not run groups in parallel.
 *
 * Not reachable from the internet: a named entrypoint is only callable through a binding.
 */
export class CheckRunner extends WorkerEntrypoint<Env> {
  async runChecks(monitors: ClaimedMonitor[]): Promise<CheckResult[]> {
    return runChecks(monitors, {
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
    });
  }
}
