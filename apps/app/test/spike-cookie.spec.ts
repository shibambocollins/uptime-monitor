import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

// SPIKE (Phase 0 P7, remove after Phase 0). The browser half of P7 is checked by hand on the
// deployed Worker; this checks the server half: the attributes and the round trip.
const ENDPOINT = 'https://app.example/api/v1/spike/cookie';

describe('spike cookie routes', () => {
  it('sets a __Host- cookie that is HttpOnly, Secure and SameSite=Lax', async () => {
    const response = await exports.default.fetch(ENDPOINT, { method: 'POST' });

    expect(response.status).toBe(200);
    const cookie = response.headers.get('Set-Cookie') ?? '';
    expect(cookie).toMatch(/^__Host-spike_session=[0-9a-f-]{36};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Domain=');
  });

  it('reports whether the cookie came back, without echoing it', async () => {
    const set = await exports.default.fetch(ENDPOINT, { method: 'POST' });
    const pair = (set.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';

    const withCookie = await exports.default.fetch(ENDPOINT, { headers: { Cookie: pair } });
    const body = await withCookie.text();
    expect(JSON.parse(body)).toEqual({ received: true });
    expect(body).not.toContain(pair.split('=')[1]);

    const without = await exports.default.fetch(ENDPOINT);
    expect(await without.json()).toEqual({ received: false });
  });

  it('clears the cookie', async () => {
    const response = await exports.default.fetch(ENDPOINT, { method: 'DELETE' });
    expect(response.headers.get('Set-Cookie')).toMatch(/^__Host-spike_session=;.*Max-Age=0/);
  });
});
