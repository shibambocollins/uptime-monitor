import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppDeps, AppEnv } from '../app-env';
import { pkceChallenge, randomToken, safeEqual } from './crypto';
import { exchangeCode, fetchProfile, GITHUB_AUTHORIZE_URL, GithubError } from './github';
import { createSession, deleteSession, SESSION_COOKIE, SESSION_TTL_MS } from './sessions';
import { upsertGithubUser } from './users';

/** Holds `state.verifier` between /login and /callback. */
export const OAUTH_COOKIE = '__Host-oauth';
const OAUTH_TTL_SECONDS = 10 * 60;
export const CALLBACK_PATH = '/api/v1/auth/github/callback';

/**
 * No scopes: the public profile (id, login, name, avatar) needs none. `user:email` will be
 * asked for when email alerts exist, so we never hold personal data we don't use (POPIA).
 */
const SCOPES = '';

/** Where the browser lands after the callback. The UI reads `login_error`. */
export type LoginError = 'denied' | 'state' | 'github';

/**
 * GitHub OAuth (authorization code flow with `state` and PKCE S256, CLAUDE.md §8).
 * Mounted at /api/v1/auth. The flow is browser navigation, so failures redirect to the
 * app with a reason instead of returning JSON.
 */
export function authRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get('/github/login', async (c) => {
    const state = randomToken();
    const verifier = randomToken();
    // SameSite=Lax, not Strict: the browser must send it on GitHub's top-level redirect back.
    setCookie(c, OAUTH_COOKIE, `${state}.${verifier}`, {
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: OAUTH_TTL_SECONDS,
    });
    const url = new URL(GITHUB_AUTHORIZE_URL);
    url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', c.env.APP_ORIGIN + CALLBACK_PATH);
    if (SCOPES !== '') url.searchParams.set('scope', SCOPES);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', await pkceChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('allow_signup', 'true');
    return c.redirect(url.toString(), 302);
  });

  app.get('/github/callback', async (c) => {
    const fail = (reason: LoginError, detail?: string) => {
      console.log({ event: 'login_failed', reason, detail });
      return c.redirect(`/?login_error=${reason}`, 302);
    };

    // Single use: whatever happens next, this state can't be replayed.
    const saved = getCookie(c, OAUTH_COOKIE);
    deleteCookie(c, OAUTH_COOKIE, { path: '/', secure: true });

    const { code, state, error } = c.req.query();
    if (error !== undefined) return fail('denied', error === 'access_denied' ? undefined : error);

    const [savedState, verifier] = saved?.split('.') ?? [];
    if (!code || !state || !savedState || !verifier || !safeEqual(state, savedState)) {
      return fail('state');
    }

    let userId: number;
    try {
      const accessToken = await exchangeCode(deps.fetch, {
        clientId: c.env.GITHUB_CLIENT_ID,
        clientSecret: c.env.GITHUB_CLIENT_SECRET,
        code,
        codeVerifier: verifier,
        redirectUri: c.env.APP_ORIGIN + CALLBACK_PATH,
      });
      // The access token is only used for this one call: never stored, never logged.
      const profile = await fetchProfile(deps.fetch, accessToken);
      const result = await upsertGithubUser(c.env.DB, profile, deps.now());
      userId = result.userId;
      console.log({ event: 'login', userId, created: result.created });
    } catch (err) {
      if (err instanceof GithubError) return fail('github', `${err.kind}:${err.code}`);
      throw err;
    }

    // A new session on every login (no session fixation); the old one, if any, is ended.
    const previous = getCookie(c, SESSION_COOKIE);
    if (previous) await deleteSession(c.env.DB, previous);
    const session = await createSession(c.env.DB, userId, deps.now());
    setCookie(c, SESSION_COOKIE, session.token, {
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.redirect('/', 302);
  });

  // POST, so a link or an image can't log someone out. SameSite=Lax keeps the cookie off
  // cross-site POSTs, so another site can't submit this form with it either.
  app.post('/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deleteSession(c.env.DB, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    return c.body(null, 204);
  });

  return app;
}
