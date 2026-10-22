import { createExecutionContext, createScheduledController } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimDueMonitors } from '../src/checker/claim';
import type { ClaimedMonitor } from '../src/checker/claim';
import { type CheckResult, type FetchFn, runChecks } from '../src/checker/run-checks';
import { runTick, type TickDeps } from '../src/checker/tick';
import worker from '../src/index';

// A cron minute at the start of an hour, so a few ticks share one rollup row.
const T0 = Date.UTC(2026, 9, 21, 15, 0, 0);
const MINUTE = 60_000;

beforeEach(async () => {
  await env.DB.batch(
    ['check_events', 'check_rollups_hourly', 'usage_daily', 'monitors'].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});

interface MonitorSeed {
  url?: string;
  interval_seconds?: number;
  next_run_at?: number;
  enabled?: 0 | 1;
  latency_threshold_ms?: number;
}

async function addMonitor(seed: MonitorSeed = {}): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO monitors (url, interval_seconds, next_run_at, enabled, latency_threshold_ms)
     VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id`,
  )
    .bind(
      seed.url ?? 'https://target.example/',
      seed.interval_seconds ?? 60,
      seed.next_run_at ?? T0,
      seed.enabled ?? 1,
      seed.latency_threshold_ms ?? 2000,
    )
    .first<{ id: number }>();
  return row!.id;
}

function deps(fetch: FetchFn, overrides: Partial<TickDeps> = {}) {
  const logs: Record<string, unknown>[] = [];
  const tickDeps: TickDeps = {
    db: env.DB,
    // In production each group runs in a CheckRunner invocation; here the same code runs
    // in-process, with the fake fetch.
    runGroup: (group) => runChecks(group, { fetch, now: () => tickDeps.now() }),
    now: () => T0,
    sleep: async () => {},
    log: (entry) => logs.push(entry),
    tickId: 'test-tick',
    maxChecks: 40,
    slowTickMs: 0,
    ...overrides,
  };
  return { deps: tickDeps, logs };
}

const respond =
  (status: number): FetchFn =>
  async () =>
    new Response(null, { status });

const all = <T>(sql: string) =>
  env.DB.prepare(sql)
    .all<T>()
    .then((r) => r.results);

describe('claimDueMonitors', () => {
  it('claims only enabled, due monitors and moves next_run_at one interval past the tick', async () => {
    const due = await addMonitor({ interval_seconds: 300, next_run_at: T0 - MINUTE });
    await addMonitor({ next_run_at: T0 + MINUTE });
    await addMonitor({ enabled: 0 });

    const { monitors } = await claimDueMonitors(env.DB, T0, 40);

    expect(monitors.map((m) => m.id)).toEqual([due]);
    const row = await env.DB.prepare('SELECT next_run_at FROM monitors WHERE id = ?')
      .bind(due)
      .first<{ next_run_at: number }>();
    expect(row?.next_run_at).toBe(T0 + 300_000);
  });

  // P6: the advanced next_run_at is the lease. An overlapping tick sees nothing to do.
  it('does not hand the same monitor to a second claim', async () => {
    await addMonitor({ interval_seconds: 300 });
    expect((await claimDueMonitors(env.DB, T0, 40)).monitors).toHaveLength(1);
    expect((await claimDueMonitors(env.DB, T0 + MINUTE, 40)).monitors).toHaveLength(0);
  });

  it('respects the limit, most overdue first', async () => {
    const oldest = await addMonitor({ next_run_at: T0 - 3 * MINUTE });
    const older = await addMonitor({ next_run_at: T0 - 2 * MINUTE });
    await addMonitor({ next_run_at: T0 - MINUTE });

    const { monitors } = await claimDueMonitors(env.DB, T0, 2);
    expect(monitors.map((m) => m.id).sort()).toEqual([oldest, older].sort());
  });

  it('returns the current state and counters', async () => {
    const id = await addMonitor();
    await env.DB.prepare(
      `UPDATE monitors SET state = 'DOWN', consecutive_successes = 1 WHERE id = ?`,
    )
      .bind(id)
      .run();

    const [claimed] = (await claimDueMonitors(env.DB, T0, 40)).monitors;
    expect(claimed?.status).toEqual({
      state: 'DOWN',
      consecutiveFailures: 0,
      consecutiveSlow: 0,
      consecutiveSuccesses: 1,
    });
  });
});

describe('runTick', () => {
  it('writes only a rollup for a healthy check, and leaves the monitor row alone', async () => {
    const id = await addMonitor();
    const { deps: d, logs } = deps(respond(200));

    const stats = await runTick(T0, d);

    expect(stats).toMatchObject({ claimed: 1, failures: 0, statements: 1, transitions: [] });
    expect(await all('SELECT * FROM check_rollups_hourly')).toEqual([
      {
        monitor_id: id,
        hour: T0,
        total: 1,
        failures: 0,
        latency_sum_ms: 0,
        lt_250: 1,
        lt_500: 0,
        lt_1000: 0,
        lt_2500: 0,
        lt_5000: 0,
        ge_5000: 0,
      },
    ]);
    expect(await all('SELECT * FROM check_events')).toEqual([]);
    expect(await all('SELECT ticks, checks FROM usage_daily')).toEqual([{ ticks: 1, checks: 1 }]);
    expect(logs).toEqual([expect.objectContaining({ event: 'tick', tickId: 'test-tick' })]);
  });

  it('goes DOWN on the third consecutive failure and records each failure', async () => {
    const id = await addMonitor();
    const { deps: d } = deps(respond(503));

    const ticks = [];
    for (const time of [T0, T0 + MINUTE, T0 + 2 * MINUTE]) ticks.push(await runTick(time, d));

    expect(ticks.map((t) => t.transitions)).toEqual([
      [],
      [],
      [{ monitorId: id, from: 'UP', to: 'DOWN' }],
    ]);
    expect(await all('SELECT state, consecutive_failures FROM monitors')).toEqual([
      { state: 'DOWN', consecutive_failures: 0 },
    ]);
    expect(
      await all('SELECT success, status_code, error, state FROM check_events ORDER BY id'),
    ).toEqual([
      { success: 0, status_code: 503, error: 'unexpected status 503', state: 'UP' },
      { success: 0, status_code: 503, error: 'unexpected status 503', state: 'UP' },
      { success: 0, status_code: 503, error: 'unexpected status 503', state: 'DOWN' },
    ]);
    // Same hour, so one rollup row accumulates all three.
    expect(await all('SELECT total, failures FROM check_rollups_hourly')).toEqual([
      { total: 3, failures: 3 },
    ]);
  });

  it('records the recovery as an event even though the check succeeded', async () => {
    const id = await addMonitor();
    await env.DB.prepare(
      `UPDATE monitors SET state = 'DOWN', consecutive_successes = 1 WHERE id = ?`,
    )
      .bind(id)
      .run();

    const stats = await runTick(T0, deps(respond(200)).deps);

    expect(stats.transitions).toEqual([{ monitorId: id, from: 'DOWN', to: 'UP' }]);
    expect(await all('SELECT success, state FROM check_events')).toEqual([
      { success: 1, state: 'UP' },
    ]);
  });

  it('counts a response over the threshold as slow, not failed', async () => {
    let clock = T0;
    await addMonitor({ latency_threshold_ms: 500 });
    const slowFetch: FetchFn = async () => {
      clock += 3000;
      return new Response(null);
    };

    const stats = await runTick(T0, deps(slowFetch, { now: () => clock }).deps);

    expect(stats).toMatchObject({ failures: 0, slow: 1, latencyMs: { p50: 3000, max: 3000 } });
    expect(await all('SELECT consecutive_slow FROM monitors')).toEqual([{ consecutive_slow: 1 }]);
    expect(await all('SELECT latency_sum_ms, lt_5000 FROM check_rollups_hourly')).toEqual([
      { latency_sum_ms: 3000, lt_5000: 1 },
    ]);
  });

  it('runs no more than MAX_CHECKS_PER_TICK checks', async () => {
    for (let i = 0; i < 5; i++) await addMonitor();
    const stats = await runTick(T0, deps(respond(200), { maxChecks: 3 }).deps);
    expect(stats.claimed).toBe(3);
  });

  // P6: a tick that outlasts the next cron firing must not cause double checks.
  it('lets an overlapping tick run without re-checking claimed monitors', async () => {
    await addMonitor({ interval_seconds: 300 });
    let overlapping: Awaited<ReturnType<typeof runTick>> | undefined;
    const slow = deps(respond(200), {
      slowTickMs: 70_000,
      sleep: async () => {
        overlapping = await runTick(T0 + MINUTE, deps(respond(200)).deps);
      },
    });

    const first = await runTick(T0, slow.deps);

    expect(first.claimed).toBe(1);
    expect(overlapping?.claimed).toBe(0);
    expect(await all('SELECT ticks, checks FROM usage_daily')).toEqual([{ ticks: 2, checks: 1 }]);
  });

  it('records an empty tick in usage_daily', async () => {
    const stats = await runTick(T0, deps(respond(200)).deps);
    expect(stats).toMatchObject({ claimed: 0, statements: 0 });
    expect(await all('SELECT day, ticks, checks FROM usage_daily')).toEqual([
      { day: '2026-10-21', ticks: 1, checks: 0 },
    ]);
  });
});

describe('runTick fan-out', () => {
  /** A runGroup that answers 200 to everything and records what it was asked to do. */
  function recordingRunner(onCall?: (group: ClaimedMonitor[], call: number) => void) {
    const calls: number[][] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const runGroup = async (group: ClaimedMonitor[]): Promise<CheckResult[]> => {
      calls.push(group.map((m) => m.id));
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      onCall?.(group, calls.length);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return group.map((m) => ({
        monitorId: m.id,
        checkedAt: T0,
        success: true,
        statusCode: 200,
        responseMs: 50,
        error: null,
      }));
    };
    return { runGroup, calls, maxInFlight: () => maxInFlight };
  }

  it('checks in groups of 10, one group at a time', async () => {
    for (let i = 0; i < 25; i++) await addMonitor();
    const runner = recordingRunner();

    const stats = await runTick(T0, deps(respond(200), { runGroup: runner.runGroup }).deps);

    expect(runner.calls.map((ids) => ids.length)).toEqual([10, 10, 5]);
    // Groups share the 6-connection limit, so running them in parallel would inflate latency.
    expect(runner.maxInFlight()).toBe(1);
    expect(stats).toMatchObject({ claimed: 25, checked: 25, released: 0, groups: 3 });
  });

  it('stops starting groups that might not finish before the deadline, and releases them', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 25; i++) ids.push(await addMonitor());
    let clock = T0;
    // Each group takes 1 s. The next group's worst case is 2 rounds of 10 s timeouts = 20 s,
    // so with a 20.5 s deadline only the first group fits.
    const runner = recordingRunner(() => (clock += 1000));

    const stats = await runTick(
      T0,
      deps(respond(200), { runGroup: runner.runGroup, now: () => clock, deadlineMs: 20_500 }).deps,
    );

    expect(stats).toMatchObject({ claimed: 25, checked: 10, released: 15, groups: 1 });
    expect(stats.rowsWritten.release).toBe(15);
    const rows = await all<{ id: number; next_run_at: number }>(
      'SELECT id, next_run_at FROM monitors ORDER BY id',
    );
    const checked = new Set(runner.calls.flat());
    for (const row of rows) {
      // Checked: due again in one interval. Released: due now, so the next tick takes them.
      expect(row.next_run_at).toBe(checked.has(row.id) ? T0 + MINUTE : T0);
    }
    expect((await claimDueMonitors(env.DB, T0 + MINUTE, 40)).monitors).toHaveLength(25);
  });

  it('releases a group whose runner fails, without counting it as a failed check', async () => {
    for (let i = 0; i < 15; i++) await addMonitor();
    const runner = recordingRunner((_, call) => {
      if (call === 2) throw new Error('runner crashed');
    });
    const { deps: d, logs } = deps(respond(200), { runGroup: runner.runGroup });

    const stats = await runTick(T0, d);

    expect(stats).toMatchObject({ checked: 10, released: 5, runnerErrors: 1, failures: 0 });
    expect(await all('SELECT COUNT(*) AS n FROM check_events')).toEqual([{ n: 0 }]);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'runner_failed', error: 'Error: runner crashed' }),
    );
  });
});

describe('CheckRunner', () => {
  it('runs checks in its own invocation and returns plain results', async () => {
    // An invalid URL makes fetch() throw at once, so this needs no network.
    const monitor: ClaimedMonitor = {
      id: 7,
      url: 'not a url',
      timeoutMs: 1000,
      latencyThresholdMs: 2000,
      expectedStatus: 200,
      status: { state: 'UP', consecutiveFailures: 0, consecutiveSlow: 0, consecutiveSuccesses: 0 },
    };

    const [result] = await exports.CheckRunner.runChecks([monitor]);

    expect(result).toMatchObject({ monitorId: 7, success: false, statusCode: null });
    expect(result?.error).toMatch(/^TypeError/);
  });
});

describe('scheduled()', () => {
  it('runs a tick for the cron time, with groups going through CheckRunner', async () => {
    await addMonitor({ url: 'not a url' });
    const controller = createScheduledController({ scheduledTime: T0, cron: '* * * * *' });

    await worker.scheduled(controller, env, createExecutionContext());

    expect(await all('SELECT day, ticks, checks FROM usage_daily')).toEqual([
      { day: '2026-10-21', ticks: 1, checks: 1 },
    ]);
    expect(await all('SELECT error FROM check_events')).toEqual([
      { error: expect.stringMatching(/^TypeError/) },
    ]);
  });
});
