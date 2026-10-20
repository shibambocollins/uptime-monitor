import { Hono } from 'hono';
import {
  DEFAULT_CYCLE,
  isFlapDown,
  phaseAt,
  phasesBetween,
  type PhaseSpec,
  type PhaseWindow,
} from './schedule.ts';

export interface AppOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  bootedAt?: number;
  cycle?: readonly PhaseSpec[];
  slowMs?: number;
}

export const MAX_DELAY_MS = 30_000;
const DAY_MS = 24 * 60 * 60_000;
const MAX_SCHEDULE_RANGE_MS = 7 * DAY_MS;

// Statuses whose responses must not carry a body (the Response constructor rejects one).
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export function createApp(options: AppOptions = {}): Hono {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const bootedAt = options.bootedAt ?? now();
  const cycle = options.cycle ?? DEFAULT_CYCLE;
  const slowMs = options.slowMs ?? 3_000;

  const app = new Hono();

  // A test fixture must never be answered from a cache.
  app.use(async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });

  // Always healthy: Render's health check uses this, never /scheduled.
  app.get('/ping', (c) => c.json({ ok: true }));

  app.get('/delay/:ms', async (c) => {
    const ms = parseNonNegativeInt(c.req.param('ms'));
    if (ms === null || ms > MAX_DELAY_MS) {
      return c.json({ error: `ms must be an integer from 0 to ${MAX_DELAY_MS}` }, 400);
    }
    await sleep(ms);
    return c.json({ ok: true, delayedMs: ms });
  });

  app.get('/status/:code', (c) => {
    const code = parseNonNegativeInt(c.req.param('code'));
    if (code === null || code < 200 || code > 599) {
      return c.json({ error: 'code must be an integer from 200 to 599' }, 400);
    }
    const body = NULL_BODY_STATUSES.has(code) ? null : JSON.stringify({ status: code });
    return new Response(body, {
      status: code,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  app.get('/scheduled', async (c) => {
    const time = now();
    const { phase } = phaseAt(time, cycle);
    switch (phase) {
      case 'UP':
        return c.json({ phase });
      case 'DOWN':
        return c.json({ phase }, 503);
      case 'SLOW':
        await sleep(slowMs);
        return c.json({ phase });
      case 'FLAPPING':
        return isFlapDown(time) ? c.json({ phase, up: false }, 503) : c.json({ phase, up: true });
    }
  });

  // Ground truth for measuring the monitor: what /scheduled was doing, and when this
  // process started (a new bootedAt means Render restarted it, which is not a planned outage).
  app.get('/schedule', (c) => {
    const time = now();
    const to = parseTime(c.req.query('to'), time);
    const from = parseTime(c.req.query('from'), to - DAY_MS);
    if (Number.isNaN(from) || Number.isNaN(to)) {
      return c.json({ error: 'from and to must be ISO 8601 timestamps' }, 400);
    }
    if (from >= to || to - from > MAX_SCHEDULE_RANGE_MS) {
      return c.json({ error: 'from must be before to, and the range at most 7 days' }, 400);
    }
    return c.json({
      now: new Date(time).toISOString(),
      bootedAt: new Date(bootedAt).toISOString(),
      slowMs,
      current: toJson(phaseAt(time, cycle)),
      windows: phasesBetween(from, to, cycle).map(toJson),
    });
  });

  return app;
}

function parseNonNegativeInt(value: string): number | null {
  return /^\d{1,6}$/.test(value) ? Number(value) : null;
}

/** Missing → fallback; present but unparseable → NaN. */
function parseTime(value: string | undefined, fallback: number): number {
  return value === undefined ? fallback : Date.parse(value);
}

function toJson(window: PhaseWindow) {
  return {
    phase: window.phase,
    start: new Date(window.start).toISOString(),
    end: new Date(window.end).toISOString(),
  };
}
