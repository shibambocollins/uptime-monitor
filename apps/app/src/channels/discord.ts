import { type FetchFn, USER_AGENT } from '../checker/run-checks';

// Discord webhooks (CLAUDE.md §7). Only Discord's own hosts and the
// /api/webhooks/{id}/{token} shape are accepted, and the URL is rebuilt on discord.com, so
// we only ever send requests to discord.com: no SSRF through this feature.

const HOSTS = new Set(['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']);
// /api/webhooks/... or a versioned /api/v10/webhooks/...; ids are numeric snowflakes. The
// token length isn't documented as fixed, so the pattern is lenient about it.
const PATH = /^\/api(?:\/v\d+)?\/webhooks\/(\d{15,25})\/([A-Za-z0-9_-]{20,200})\/?$/;
const TIMEOUT_MS = 10_000;

export interface DiscordWebhook {
  /** Canonical form, always on https://discord.com. Secret. */
  url: string;
  /** The last 4 characters of the token: what the UI may show. */
  hint: string;
}

export function parseDiscordWebhook(input: string): DiscordWebhook | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port !== '') return null;
  if (url.username !== '' || url.password !== '') return null;
  const match = PATH.exec(url.pathname);
  if (!match) return null;
  const [, id, token] = match as unknown as [string, string, string];
  return { url: `https://discord.com/api/webhooks/${id}/${token}`, hint: token.slice(-4) };
}

export type SendResult =
  | { ok: true }
  /** 404 or 401: the webhook was deleted or its token is wrong. Retrying won't help. */
  | { ok: false; kind: 'gone'; status: number }
  /** 429: wait `retryAfterMs` before this webhook's next message. */
  | { ok: false; kind: 'rate_limited'; retryAfterMs: number }
  /** Network error, timeout, 5xx, or another unexpected answer: retry later. */
  | { ok: false; kind: 'unavailable'; status: number | null };

/**
 * Posts one plain-text message. allowed_mentions with no parse types means nothing in the
 * text (a team or monitor name with "@everyone", say) can ping anyone.
 */
export async function sendDiscordMessage(
  fetch: FetchFn,
  webhookUrl: string,
  content: string,
): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, kind: 'unavailable', status: null };
  }

  if (response.ok) {
    await response.body?.cancel();
    return { ok: true };
  }
  if (response.status === 429) {
    return { ok: false, kind: 'rate_limited', retryAfterMs: await retryAfterMs(response) };
  }
  await response.body?.cancel();
  if (response.status === 404 || response.status === 401) {
    return { ok: false, kind: 'gone', status: response.status };
  }
  return { ok: false, kind: 'unavailable', status: response.status };
}

/** Discord sends retry_after (seconds, may be fractional) in the body and a Retry-After header. */
async function retryAfterMs(response: Response): Promise<number> {
  let seconds = Number(response.headers.get('Retry-After'));
  try {
    const body = (await response.json()) as { retry_after?: unknown };
    if (typeof body.retry_after === 'number') seconds = body.retry_after;
  } catch {
    // keep the header value
  }
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 5_000;
}
