import { describe, expect, it } from 'vitest';
import { createApp, MAX_DELAY_MS } from './app.ts';
import { MINUTE_MS } from './schedule.ts';

const min = (n: number) => n * MINUTE_MS;

interface WindowJson {
  phase: string;
  start: string;
  end: string;
}

interface ScheduleBody {
  bootedAt: string;
  current: WindowJson;
  windows: WindowJson[];
}

/** An app with a fixed clock and a sleep that records instead of waiting. */
function setup(time = 0) {
  const slept: number[] = [];
  const app = createApp({
    now: () => time,
    sleep: async (ms) => {
      slept.push(ms);
    },
    bootedAt: 0,
    slowMs: 3_000,
  });
  return { app, slept };
}

describe('GET /ping', () => {
  it('returns 200 and is never cached', async () => {
    const res = await setup().app.request('/ping');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('GET /delay/:ms', () => {
  it('waits the requested time', async () => {
    const { app, slept } = setup();
    const res = await app.request('/delay/1500');
    expect(res.status).toBe(200);
    expect(slept).toEqual([1500]);
  });

  it.each(['-1', 'abc', '1.5', String(MAX_DELAY_MS + 1)])('rejects %s', async (ms) => {
    const { app, slept } = setup();
    const res = await app.request(`/delay/${ms}`);
    expect(res.status).toBe(400);
    expect(slept).toEqual([]);
  });
});

describe('GET /status/:code', () => {
  it.each([200, 404, 500, 503])('returns %i', async (code) => {
    const res = await setup().app.request(`/status/${code}`);
    expect(res.status).toBe(code);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns 204 with no body', async () => {
    const res = await setup().app.request('/status/204');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it.each(['199', '600', 'x'])('rejects %s', async (code) => {
    const res = await setup().app.request(`/status/${code}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /scheduled', () => {
  it('returns 200 during UP', async () => {
    const res = await setup(min(10)).app.request('/scheduled');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ phase: 'UP' });
  });

  it('returns 503 during DOWN', async () => {
    const res = await setup(min(65)).app.request('/scheduled');
    expect(res.status).toBe(503);
  });

  it('returns 200 after the slow delay during SLOW', async () => {
    const { app, slept } = setup(min(95));
    const res = await app.request('/scheduled');
    expect(res.status).toBe(200);
    expect(slept).toEqual([3_000]);
  });

  it('alternates by minute during FLAPPING', async () => {
    expect((await setup(min(110)).app.request('/scheduled')).status).toBe(200);
    expect((await setup(min(111)).app.request('/scheduled')).status).toBe(503);
  });
});

describe('GET /schedule', () => {
  it('reports the current phase, boot time and the last 24 hours by default', async () => {
    const res = await setup(min(65)).app.request('/schedule');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ScheduleBody;
    expect(body.current).toEqual({
      phase: 'DOWN',
      start: new Date(min(60)).toISOString(),
      end: new Date(min(80)).toISOString(),
    });
    expect(body.bootedAt).toBe(new Date(0).toISOString());
    expect(body.windows.at(-1)).toEqual(body.current);
  });

  it('accepts an explicit range', async () => {
    const from = new Date(min(70)).toISOString();
    const to = new Date(min(95)).toISOString();
    const res = await setup().app.request(`/schedule?from=${from}&to=${to}`);
    const body = (await res.json()) as ScheduleBody;
    expect(body.windows.map((w) => w.phase)).toEqual(['DOWN', 'UP', 'SLOW']);
  });

  it.each([
    ['an unparseable date', '?from=yesterday'],
    ['from after to', `?from=${new Date(min(10)).toISOString()}&to=${new Date(0).toISOString()}`],
    [
      'more than 7 days',
      `?from=${new Date(0).toISOString()}&to=${new Date(min(60 * 24 * 8)).toISOString()}`,
    ],
  ])('rejects %s', async (_label, query) => {
    const res = await setup(min(60 * 24 * 10)).app.request(`/schedule${query}`);
    expect(res.status).toBe(400);
  });
});
