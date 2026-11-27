import { describe, expect, it } from 'vitest';
import type { FetchFn } from '../src/checker/run-checks';
import { checkHostDns } from '../src/monitors/dns';

interface Call {
  url: URL;
  init: RequestInit;
}

/** A fake DoH server: `answers[type]` is the JSON body for that record type. */
function doh(answers: Partial<Record<'A' | 'AAAA', unknown>>, status = 200) {
  const calls: Call[] = [];
  const fetch: FetchFn = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    const type = parsed.searchParams.get('type') as 'A' | 'AAAA';
    return Response.json(answers[type] ?? { Status: 0 }, { status });
  };
  return { fetch, calls };
}

const records =
  (type: number) =>
  (...data: string[]) => ({
    Status: 0,
    Answer: data.map((d) => ({ name: 'shop.example.com', type, TTL: 300, data: d })),
  });
const a = records(1);
const aaaa = records(28);

const networkDown: FetchFn = async () => {
  throw new TypeError('Network connection lost.');
};

describe('checkHostDns', () => {
  it('asks Cloudflare DoH for A and AAAA as JSON, with a timeout', async () => {
    const { fetch, calls } = doh({ A: a('93.184.215.14') });
    expect(await checkHostDns(fetch, 'shop.example.com')).toEqual({
      ok: true,
      addresses: ['93.184.215.14'],
    });
    expect(calls.map((c) => c.url.searchParams.get('type')).sort()).toEqual(['A', 'AAAA']);
    for (const { url, init } of calls) {
      expect(url.origin + url.pathname).toBe('https://cloudflare-dns.com/dns-query');
      expect(url.searchParams.get('name')).toBe('shop.example.com');
      expect(new Headers(init.headers).get('Accept')).toBe('application/dns-json');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([
    ['a private IPv4 address', { A: a('93.184.215.14', '10.0.0.5') }],
    ['loopback', { A: a('127.0.0.1') }],
    ['cloud metadata', { A: a('169.254.169.254') }],
    ['IPv6 loopback', { AAAA: aaaa('::1') }],
    ['an IPv4-mapped private address', { AAAA: aaaa('::ffff:192.168.1.1') }],
  ])('rejects a name with %s among its answers', async (_label, answers) => {
    expect(await checkHostDns(doh(answers).fetch, 'shop.example.com')).toEqual({
      ok: false,
      reason: 'BLOCKED_ADDRESS',
    });
  });

  it('follows a CNAME chain to the final addresses', async () => {
    const chain = {
      Status: 0,
      Answer: [
        { name: 'www.example.com', type: 5, TTL: 300, data: 'cdn.example.net.' },
        { name: 'cdn.example.net', type: 1, TTL: 300, data: '93.184.215.14' },
      ],
    };
    expect(await checkHostDns(doh({ A: chain }).fetch, 'www.example.com')).toEqual({
      ok: true,
      addresses: ['93.184.215.14'],
    });
  });

  it('reports a name with no addresses as NOT_FOUND', async () => {
    const nx = { Status: 3 };
    expect(await checkHostDns(doh({ A: nx, AAAA: nx }).fetch, 'nope.example.com')).toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
    expect(await checkHostDns(doh({}).fetch, 'empty.example.com')).toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
  });

  it.each([
    ['SERVFAIL', doh({ A: { Status: 2 } }).fetch],
    ['an HTTP error', doh({}, 503).fetch],
    ['a non-address answer', doh({ A: a('not-an-ip') }).fetch],
    ['a malformed body', doh({ A: { Status: 0, Answer: 'x' } }).fetch],
    ['a network error', networkDown],
  ])('fails closed on %s', async (_label, fetch) => {
    expect(await checkHostDns(fetch, 'shop.example.com')).toEqual({
      ok: false,
      reason: 'UNAVAILABLE',
    });
  });

  it('skips IP literals, which the URL validator already checked', async () => {
    const { fetch, calls } = doh({});
    expect(await checkHostDns(fetch, '93.184.215.14')).toEqual({ ok: true, addresses: [] });
    expect(await checkHostDns(fetch, '[2606:4700::1111]')).toEqual({ ok: true, addresses: [] });
    expect(calls).toEqual([]);
  });
});
