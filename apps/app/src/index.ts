import { createApp } from './app';
import type { FetchFn } from './checker/run-checks';
import { runTick } from './checker/tick';
import { bindingRateLimit } from './http/rate-limit';
import { checkHostDns } from './monitors/dns';

// A top-level export, so the tick can reach it through ctx.exports.
export { CheckRunner } from './checker/runner';

const outbound: FetchFn = (url, init) => fetch(url, init);
const app = createApp({
  fetch: outbound,
  now: () => Date.now(),
  rateLimit: bindingRateLimit,
  checkHost: (hostname) => checkHostDns(outbound, hostname),
});

export default {
  fetch: app.fetch,

  async scheduled(controller, env, ctx) {
    const tickId = crypto.randomUUID();
    try {
      await runTick(controller.scheduledTime, {
        db: env.DB,
        // Each call is a separate invocation with its own CPU budget (checker/runner.ts).
        runGroup: (monitors) => ctx.exports.CheckRunner.checkGroup(monitors),
        now: () => Date.now(),
        // Workers Logs indexes the fields of a logged object (CLAUDE.md §11).
        log: (entry) => console.log(entry),
        tickId,
        maxChecks: readIntVar(env.MAX_CHECKS_PER_TICK, 40),
      });
    } catch (error) {
      console.error({ event: 'tick_failed', tickId, error: String(error) });
      // Rethrow so the invocation counts as an error in the Workers dashboard (P1).
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;

function readIntVar(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
