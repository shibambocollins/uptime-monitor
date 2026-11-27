import { describe, expect, it } from 'vitest';
import { heartbeatUrl, pingHeartbeat } from '../src/checker/heartbeat';
import type { FetchFn } from '../src/checker/run-checks';
import type { TickStats } from '../src/checker/tick';

const URL_ = 'https://hc-ping.com/0f0e5b4e-1c3a-4f43-9a4e-5d4c3b2a1f00';
const stats = {
  checked: 12,
  failures: 1,
  rowsWritten: { total: 25 },
  durationMs: 1800,
} as unknown as TickStats;

function recorder(status = 200, fail = false) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    if (fail) throw new TypeError('Network connection lost.');
    return new Response('OK', { status });
  };
  const logs: Record<string, unknown>[] = [];
  return { calls, fetch, logs, log: (e: Record<string, unknown>) => logs.push(e) };
}

describe('heartbeatUrl', () => {
  it('uses the configured URL, and its /fail form after a failed tick', () => {
    expect(heartbeatUrl(URL_, false)).toBe(URL_);
    expect(heartbeatUrl(`${URL_}/`, true)).toBe(`${URL_}/fail`);
  });

  it.each([undefined, '', 'not a url', 'http://hc-ping.com/abc'])(
    'sends nothing for %j',
    (secret) => expect(heartbeatUrl(secret, false)).toBeNull(),
  );
});

describe('pingHeartbeat', () => {
  it('posts the tick numbers to the ping URL', async () => {
    const r = recorder();
    await pingHeartbeat(r.fetch, URL_, { stats }, r.log);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.url).toBe(URL_);
    expect(JSON.parse(r.calls[0]!.init.body as string)).toEqual({
      checked: 12,
      failures: 1,
      rowsWritten: 25,
      durationMs: 1800,
    });
    expect(r.logs).toEqual([]);
  });

  it('reports a failed tick to /fail with the error', async () => {
    const r = recorder();
    await pingHeartbeat(r.fetch, URL_, { error: 'D1_ERROR: daily limit' }, r.log);
    expect(r.calls[0]!.url).toBe(`${URL_}/fail`);
    expect(r.calls[0]!.init.body).toBe('tick failed: D1_ERROR: daily limit');
  });

  it('does nothing when no URL is configured', async () => {
    const r = recorder();
    await pingHeartbeat(r.fetch, undefined, { stats }, r.log);
    expect(r.calls).toEqual([]);
  });

  it('never throws, and logs the failure without the secret URL', async () => {
    for (const r of [recorder(500), recorder(200, true)]) {
      await expect(pingHeartbeat(r.fetch, URL_, { stats }, r.log)).resolves.toBeUndefined();
      expect(r.logs).toEqual([expect.objectContaining({ event: 'heartbeat_failed' })]);
      expect(JSON.stringify(r.logs)).not.toContain('hc-ping');
    }
  });
});
