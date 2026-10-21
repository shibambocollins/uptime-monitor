import { Hono } from 'hono';
import { runTick } from './checker/tick';
import { spikeCookie } from './spike/cookie';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/v1/health', (c) => c.json({ status: 'ok' }));
// SPIKE (Phase 0 P7, remove after Phase 0).
app.route('/api/v1/spike', spikeCookie);

export default {
  fetch: app.fetch,

  async scheduled(controller, env) {
    const tickId = crypto.randomUUID();
    try {
      await runTick(controller.scheduledTime, {
        db: env.DB,
        fetch: (url, init) => fetch(url, init),
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        // Workers Logs indexes the fields of a logged object (CLAUDE.md §11).
        log: (entry) => console.log(entry),
        tickId,
        maxChecks: readIntVar(env.MAX_CHECKS_PER_TICK, 40),
        slowTickMs: readIntVar(env.SPIKE_SLOW_TICK_MS, 0),
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
