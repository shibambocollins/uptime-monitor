import { type FetchFn, USER_AGENT } from '../checker/run-checks';

// GitHub's OAuth web flow for OAuth Apps (docs: "Authorizing OAuth apps"). `fetch` is
// passed in so tests can fake GitHub, as the checker does.

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const TIMEOUT_MS = 10_000;

export interface GithubProfile {
  /** GitHub's immutable numeric user id: the identity (CLAUDE.md §8). */
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/**
 * `rejected`: GitHub refused (an expired or reused code, a wrong verifier). `unavailable`:
 * GitHub could not be reached or answered with an HTTP error. `code` is GitHub's error
 * code or ours; never a token.
 */
export class GithubError extends Error {
  constructor(
    readonly kind: 'rejected' | 'unavailable',
    readonly code: string,
  ) {
    super(`GitHub ${kind}: ${code}`);
    this.name = 'GithubError';
  }
}

export interface CodeExchange {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/** Trades the callback's code for an access token. The token is used once and dropped. */
export async function exchangeCode(fetch: FetchFn, exchange: CodeExchange): Promise<string> {
  const response = await call(fetch, TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams({
      client_id: exchange.clientId,
      client_secret: exchange.clientSecret,
      code: exchange.code,
      code_verifier: exchange.codeVerifier,
      redirect_uri: exchange.redirectUri,
    }).toString(),
  });
  // GitHub reports OAuth errors (bad_verification_code, ...) in a 200 JSON body.
  const body = ((await readJson(response)) ?? {}) as { access_token?: unknown; error?: unknown };
  if (typeof body.access_token === 'string' && body.access_token !== '') {
    return body.access_token;
  }
  throw new GithubError('rejected', typeof body.error === 'string' ? body.error : 'no_token');
}

export async function fetchProfile(fetch: FetchFn, accessToken: string): Promise<GithubProfile> {
  const response = await call(fetch, USER_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub's REST API rejects requests without a User-Agent.
      'User-Agent': USER_AGENT,
    },
  });
  const body = await readJson(response);
  if (typeof body !== 'object' || body === null)
    throw new GithubError('unavailable', 'bad_profile');
  const { id, login, name, avatar_url: avatarUrl } = body as Record<string, unknown>;
  if (!Number.isSafeInteger(id) || (id as number) <= 0 || typeof login !== 'string') {
    throw new GithubError('unavailable', 'bad_profile');
  }
  return {
    id: id as number,
    login,
    name: typeof name === 'string' ? name : null,
    avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : null,
  };
}

async function call(fetch: FetchFn, url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new GithubError('unavailable', 'network');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new GithubError('unavailable', `http_${response.status}`);
  }
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new GithubError('unavailable', 'bad_json');
  }
}
