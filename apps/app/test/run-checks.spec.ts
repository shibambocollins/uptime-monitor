import { describe, expect, it } from 'vitest';
import type { ClaimedMonitor } from '../src/checker/claim';
import { type FetchFn, runCheck, runChecks, USER_AGENT } from '../src/checker/run-checks';

function monitor(id: number, overrides: Partial<ClaimedMonitor> = {}): ClaimedMonitor {
  return {
    id,
    url: `https://target.example/${id}`,
    timeoutMs: 5000,
    latencyThresholdMs: 2000,
    expectedStatus: 200,
    status: { state: 'UP', consecutiveFailures: 0, consecutiveSlow: 0, consecutiveSuccesses: 0 },
    ...overrides,
  };
}

const fixedClock = () => 1_000;

describe('runCheck', () => {
  it('sends a GET with our User-Agent, manual redirects and a timeout signal', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetch: FetchFn = async (url, init) => {
      seen = { url, init };
      return new Response('ok');
    };

    await runCheck(monitor(1), { fetch, now: fixedClock });

    expect(seen?.url).toBe('https://target.example/1');
    expect(seen?.init.method).toBe('GET');
    expect(seen?.init.redirect).toBe('manual');
    expect(new Headers(seen?.init.headers).get('User-Agent')).toBe(USER_AGENT);
    expect(seen?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('succeeds when the status matches', async () => {
    const result = await runCheck(monitor(1), {
      fetch: async () => new Response('ok'),
      now: fixedClock,
    });
    expect(result).toEqual({
      monitorId: 1,
      checkedAt: 1_000,
      success: true,
      statusCode: 200,
      responseMs: 0,
      error: null,
    });
  });

  it('fails on an unexpected status but still records the latency', async () => {
    const result = await runCheck(monitor(1), {
      fetch: async () => new Response(null, { status: 503 }),
      now: fixedClock,
    });
    expect(result).toMatchObject({
      success: false,
      statusCode: 503,
      responseMs: 0,
      error: 'unexpected status 503',
    });
  });

  it('treats a redirect as a status, not something to follow', async () => {
    const result = await runCheck(monitor(1), {
      fetch: async () => new Response(null, { status: 301, headers: { Location: '/x' } }),
      now: fixedClock,
    });
    expect(result).toMatchObject({ success: false, statusCode: 301 });
  });

  it('reports a timeout as "timeout"', async () => {
    const result = await runCheck(monitor(1), {
      fetch: async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      now: fixedClock,
    });
    expect(result).toMatchObject({
      success: false,
      statusCode: null,
      responseMs: null,
      error: 'timeout',
    });
  });

  it('reports a connection error without throwing', async () => {
    const result = await runCheck(monitor(1), {
      fetch: async () => {
        throw new TypeError('Network connection lost.');
      },
      now: fixedClock,
    });
    expect(result).toMatchObject({ success: false, error: 'TypeError: Network connection lost.' });
  });
});

describe('runChecks', () => {
  /**
   * A fake network driven by hand: requests stay pending until the test advances the clock
   * by 100 ms and answers everything in flight. Each request therefore takes exactly 100 ms
   * once it has started, however long it waited for a free slot.
   */
  async function drive(count: number) {
    let clock = 0;
    const inFlight: (() => void)[] = [];
    let maxInFlight = 0;
    const fetch: FetchFn = () =>
      new Promise((resolve) => inFlight.push(() => resolve(new Response(null))));

    const monitors = Array.from({ length: count }, (_, i) => monitor(i + 1));
    let settled = false;
    const done = runChecks(monitors, { fetch, now: () => clock }).finally(() => {
      settled = true;
    });
    while (!settled) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const answering = inFlight.splice(0);
      maxInFlight = Math.max(maxInFlight, answering.length);
      clock += 100;
      answering.forEach((answer) => answer());
    }
    return { results: await done, maxInFlight };
  }

  it('never has more than 6 requests in flight', async () => {
    const { results, maxInFlight } = await drive(20);
    expect(results).toHaveLength(20);
    expect(maxInFlight).toBe(6);
  });

  // P4 in docs/phase-0-checklist.md: queueing must not inflate latency.
  it('starts each timer when its request starts, not when the tick starts', async () => {
    const { results } = await drive(20);
    expect(results.map((r) => r.responseMs)).toEqual(new Array(20).fill(100));
    // The last checks really did wait: they started 300 ms after the first ones.
    expect(results.at(-1)?.checkedAt).toBe(300);
  });

  it('returns results in the same order as the monitors', async () => {
    const { results } = await drive(8);
    expect(results.map((r) => r.monitorId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('does nothing for an empty list', async () => {
    expect(await runChecks([], { fetch: async () => new Response(null), now: fixedClock })).toEqual(
      [],
    );
  });
});
