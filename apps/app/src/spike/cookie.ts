import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

// SPIKE (Phase 0 P7, remove after Phase 0): proves that a cookie set by the API on the
// Worker's origin is stored by the browser and sent back by the React page's fetch() calls,
// with the attributes the real session cookie will use (CLAUDE.md §8).
export const COOKIE_NAME = 'spike_session';

/** __Host- prefix: the browser only accepts it with Secure, Path=/ and no Domain. */
const PREFIX = 'host';

export const spikeCookie = new Hono();

spikeCookie.post('/cookie', (c) => {
  setCookie(c, COOKIE_NAME, crypto.randomUUID(), {
    prefix: PREFIX,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 600,
  });
  return c.json({ set: true });
});

// Says whether the cookie arrived, never its value: the page must not be able to read it.
spikeCookie.get('/cookie', (c) =>
  c.json({ received: getCookie(c, COOKIE_NAME, PREFIX) !== undefined }),
);

spikeCookie.delete('/cookie', (c) => {
  deleteCookie(c, COOKIE_NAME, { prefix: PREFIX, secure: true, path: '/' });
  return c.json({ cleared: true });
});
