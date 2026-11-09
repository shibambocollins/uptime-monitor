import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { pkceChallenge, sha256Hex } from '../src/auth/crypto';
import { SESSION_TTL_MS } from '../src/auth/sessions';
import type { FetchFn } from '../src/checker/run-checks';
import { resetDb } from './fixtures';

const T0 = Date.UTC(2026, 10, 9, 9, 0, 0);
const ORIGIN = 'https://uptime-app.uptime-app.workers.dev'; // wrangler.jsonc APP_ORIGIN
const CALLBACK = `${ORIGIN}/api/v1/auth/github/callback`;
const ACCESS_TOKEN = 'gho_fake_access_token_never_logged';
const PROFILE = { id: 1001, login: 'octo', name: 'Octo Cat', avatar_url: 'https://a.example/1' };

beforeEach(resetDb);

// --- A fake GitHub ---

interface Call {
  url: string;
  init: RequestInit;
}

function fakeGithub(options: { token?: unknown; profile?: unknown; down?: boolean } = {}) {
  const calls: Call[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    if (options.down) throw new TypeError('Network connection lost.');
    if (url === 'https://github.com/login/oauth/access_token') {
      return Response.json(
        options.token ?? { access_token: ACCESS_TOKEN, token_type: 'bearer', scope: '' },
      );
    }
    if (url === 'https://api.github.com/user') return Response.json(options.profile ?? PROFILE);
    return new Response('unexpected URL', { status: 599 });
  };
  return { calls, fetch };
}

// --- Helpers ---

interface SetCookie {
  value: string;
  attributes: string;
}

function setCookies(response: Response): Map<string, SetCookie> {
  const cookies = new Map<string, SetCookie>();
  for (const header of response.headers.getSetCookie()) {
    const [pair = '', ...rest] = header.split(';');
    const eq = pair.indexOf('=');
    cookies.set(pair.slice(0, eq).trim(), {
      value: pair.slice(eq + 1),
      attributes: rest.join(';'),
    });
  }
  return cookies;
}

function setup(github = fakeGithub(), now = () => T0) {
  const app = createApp({ fetch: github.fetch, now });
  const request = (path: string, init: RequestInit = {}) => app.request(path, init, env);
  const withCookie = (path: string, cookie: string, init: RequestInit = {}) =>
    request(path, { ...init, headers: { Cookie: cookie } });

  /** Starts a login and returns what the browser would hold. */
  async function startLogin() {
    const response = await request('/api/v1/auth/github/login');
    const oauth = setCookies(response).get('__Host-oauth')!;
    const [state, verifier] = oauth.value.split('.') as [string, string];
    return { response, oauth, state, verifier, cookie: `__Host-oauth=${oauth.value}` };
  }

  /** A full successful login; returns the session token. */
  async function signIn(extraCookie = '') {
    const { state, cookie } = await startLogin();
    const response = await withCookie(
      `/api/v1/auth/github/callback?code=the-code&state=${state}`,
      [cookie, extraCookie].filter(Boolean).join('; '),
    );
    const session = setCookies(response).get('__Host-session');
    return { response, token: session?.value ?? '', session };
  }

  return { github, request, withCookie, startLogin, signIn };
}

const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;

// --- Tests ---

describe('PKCE', () => {
  it('computes S256 as base64url(SHA-256(verifier))', async () => {
    // Expected value computed independently with Node's crypto module.
    expect(await pkceChallenge('dBjftJeZ4CVP-mJ92K-1AyfC8rdpNpL1CYyRo7Y-2LDs')).toBe(
      'y9jurNBmZamygBo8cU6uDzk9NwVnISpTpOmgP_O4xAQ',
    );
  });
});

describe('GET /api/v1/auth/github/login', () => {
  it('redirects to GitHub with state, an S256 challenge and the exact callback URL', async () => {
    const { response, state, verifier } = await setup().startLogin();

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: 'test-client-id',
      redirect_uri: CALLBACK,
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
      allow_signup: 'true',
    });
    // No scope parameter: the public profile needs none.
    expect(location.searchParams.has('scope')).toBe(false);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).not.toBe(verifier);
  });

  it('keeps state and verifier in a short-lived HttpOnly, Secure, SameSite=Lax cookie', async () => {
    const { oauth } = await setup().startLogin();
    expect(oauth.attributes).toMatch(/Max-Age=600/);
    expect(oauth.attributes).toMatch(/Path=\//);
    expect(oauth.attributes).toMatch(/HttpOnly/);
    expect(oauth.attributes).toMatch(/Secure/);
    expect(oauth.attributes).toMatch(/SameSite=Lax/);
    expect(oauth.attributes).not.toMatch(/Domain/i);
  });

  it('uses fresh values every time', async () => {
    const app = setup();
    const a = await app.startLogin();
    const b = await app.startLogin();
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('GET /api/v1/auth/github/callback', () => {
  it('creates the user, a personal team and a session, then redirects home', async () => {
    const app = setup();
    const { state, verifier, cookie } = await app.startLogin();

    const response = await app.withCookie(
      `/api/v1/auth/github/callback?code=the-code&state=${state}`,
      cookie,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/');

    // GitHub got the code, our secret, the PKCE verifier and the same redirect_uri.
    const [tokenCall, userCall] = app.github.calls;
    expect(tokenCall!.init.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(tokenCall!.init.body as string))).toEqual({
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      code: 'the-code',
      code_verifier: verifier,
      redirect_uri: CALLBACK,
    });
    expect(new Headers(userCall!.init.headers).get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);

    const users = await env.DB.prepare('SELECT id, github_id, login, name, email FROM users').all();
    expect(users.results).toEqual([
      { id: expect.any(Number), github_id: 1001, login: 'octo', name: 'Octo Cat', email: null },
    ]);
    const members = await env.DB.prepare(
      `SELECT t.name, m.role, m.user_id FROM team_members m JOIN teams t ON t.id = m.team_id`,
    ).all();
    expect(members.results).toEqual([
      { name: "octo's team", role: 'OWNER', user_id: users.results[0]!.id },
    ]);

    const cookies = setCookies(response);
    const session = cookies.get('__Host-session')!;
    expect(session.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.attributes).toMatch(new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}`));
    expect(session.attributes).toMatch(/Path=\//);
    expect(session.attributes).toMatch(/HttpOnly/);
    expect(session.attributes).toMatch(/Secure/);
    expect(session.attributes).toMatch(/SameSite=Lax/);
    // The OAuth cookie is single use.
    expect(cookies.get('__Host-oauth')!.attributes).toMatch(/Max-Age=0/);

    // Only the hash is stored.
    const stored = await env.DB.prepare('SELECT token_hash, expires_at FROM sessions').all();
    expect(stored.results).toEqual([
      { token_hash: await sha256Hex(session.value), expires_at: T0 + SESSION_TTL_MS },
    ]);
  });

  it('updates the profile on a later login, keeps one team, and ends the old session', async () => {
    const first = setup();
    const { token: oldToken } = await first.signIn();

    const renamed = setup(fakeGithub({ profile: { ...PROFILE, login: 'octo2', name: null } }));
    const { token: newToken } = await renamed.signIn(`__Host-session=${oldToken}`);

    expect(newToken).not.toBe(oldToken);
    const users = await env.DB.prepare('SELECT github_id, login, name FROM users').all();
    expect(users.results).toEqual([{ github_id: 1001, login: 'octo2', name: null }]);
    expect(await count('SELECT COUNT(*) AS n FROM teams')).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM sessions')).toBe(1);
    expect((await renamed.withCookie('/api/v1/me', `__Host-session=${oldToken}`)).status).toBe(401);
  });

  it.each([
    ['a state that does not match the cookie', (s: string) => `code=c&state=${s}x`, true],
    ['no state', () => 'code=c', true],
    ['no code', (s: string) => `state=${s}`, true],
    [
      'no OAuth cookie (expired, or the login started in another browser)',
      (s: string) => `code=c&state=${s}`,
      false,
    ],
  ])('rejects %s without calling GitHub', async (_name, query, sendCookie) => {
    const app = setup();
    const { state, cookie } = await app.startLogin();

    const response = await app.withCookie(
      `/api/v1/auth/github/callback?${query(state)}`,
      sendCookie ? cookie : '',
    );

    expect(response.headers.get('Location')).toBe('/?login_error=state');
    expect(app.github.calls).toEqual([]);
    expect(setCookies(response).has('__Host-session')).toBe(false);
    expect(await count('SELECT COUNT(*) AS n FROM users')).toBe(0);
  });

  it('reports a cancelled sign-in without calling GitHub', async () => {
    const app = setup();
    const { state, cookie } = await app.startLogin();
    const response = await app.withCookie(
      `/api/v1/auth/github/callback?error=access_denied&state=${state}`,
      cookie,
    );
    expect(response.headers.get('Location')).toBe('/?login_error=denied');
    expect(app.github.calls).toEqual([]);
  });

  it.each([
    [
      'GitHub rejects the code (expired or already used)',
      { token: { error: 'bad_verification_code' } },
    ],
    ['GitHub is unreachable', { down: true }],
    ['GitHub returns a profile without an id', { profile: { login: 'x' } }],
  ])('creates no session when %s', async (_name, options) => {
    const app = setup(fakeGithub(options));
    const { response } = await app.signIn();
    expect(response.headers.get('Location')).toBe('/?login_error=github');
    expect(setCookies(response).has('__Host-session')).toBe(false);
    expect(await count('SELECT COUNT(*) AS n FROM sessions')).toBe(0);
  });
});

describe('GET /api/v1/me', () => {
  it('returns the signed-in user and their teams', async () => {
    const app = setup();
    const { token } = await app.signIn();

    const response = await app.withCookie('/api/v1/me', `__Host-session=${token}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: {
        id: expect.any(Number),
        login: 'octo',
        name: 'Octo Cat',
        avatarUrl: PROFILE.avatar_url,
      },
      teams: [{ id: expect.any(Number), name: "octo's team", role: 'OWNER' }],
    });
  });

  it.each([
    ['no cookie', ''],
    ['a malformed token', '__Host-session=not-a-token'],
    ['an unknown token', `__Host-session=${'A'.repeat(43)}`],
  ])('answers 401 with the standard error body for %s', async (_name, cookie) => {
    const response = await setup().withCookie('/api/v1/me', cookie);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Sign in first.' },
    });
  });

  it('rejects an expired session and deletes it', async () => {
    const { token } = await setup().signIn();
    const later = setup(fakeGithub(), () => T0 + SESSION_TTL_MS);

    expect((await later.withCookie('/api/v1/me', `__Host-session=${token}`)).status).toBe(401);
    expect(await count('SELECT COUNT(*) AS n FROM sessions')).toBe(0);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('deletes the session and clears the cookie', async () => {
    const app = setup();
    const { token } = await app.signIn();

    const response = await app.withCookie('/api/v1/auth/logout', `__Host-session=${token}`, {
      method: 'POST',
    });

    expect(response.status).toBe(204);
    expect(setCookies(response).get('__Host-session')!.attributes).toMatch(/Max-Age=0/);
    expect(await count('SELECT COUNT(*) AS n FROM sessions')).toBe(0);
    expect((await app.withCookie('/api/v1/me', `__Host-session=${token}`)).status).toBe(401);
  });

  it('is not available over GET (a link or image must not log anyone out)', async () => {
    const response = await setup().request('/api/v1/auth/logout');
    expect(response.status).toBe(404);
  });
});

describe('secrets in logs (CLAUDE.md §8)', () => {
  const logged: string[] = [];
  beforeEach(() => {
    logged.length = 0;
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('never logs the session token, OAuth values, GitHub token or client secret', async () => {
    const app = setup();
    const { state, verifier, cookie } = await app.startLogin();
    const response = await app.withCookie(
      `/api/v1/auth/github/callback?code=the-secret-code&state=${state}`,
      cookie,
    );
    const token = setCookies(response).get('__Host-session')!.value;
    await app.withCookie('/api/v1/me', `__Host-session=${token}`);
    await setup(fakeGithub({ token: { error: 'bad_verification_code' } })).signIn();
    await app.withCookie('/api/v1/auth/logout', `__Host-session=${token}`, { method: 'POST' });

    expect(logged.length).toBeGreaterThan(0); // the login events were captured
    const all = logged.join('\n');
    for (const secret of [
      token,
      state,
      verifier,
      'the-secret-code',
      ACCESS_TOKEN,
      'test-client-secret',
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('unknown API paths', () => {
  it('answer 404 with the standard error body', async () => {
    const response = await setup().request('/api/v1/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'No such endpoint.' },
    });
  });
});
