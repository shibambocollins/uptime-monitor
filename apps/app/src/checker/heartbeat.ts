import type { FetchFn } from './run-checks';
import type { TickStats } from './tick';

// The dead man's switch (CLAUDE.md §11). A cron that stops running can't report that it
// stopped, so every tick pings an outside service (Healthchecks.io), which emails the owner
// when the pings stop. A tick that fails pings ".../fail", so a broken tick (D1 down, the
// daily write cap hit) alerts at once instead of after the grace period.

/** Short: the ping runs after the tick, through ctx.waitUntil, and must not hang around. */
const PING_TIMEOUT_MS = 5_000;

/** The secret is a full ping URL (it contains the check's key). Only https is sent to. */
export function heartbeatUrl(secret: string | undefined, failed: boolean): string | null {
  if (!secret) return null;
  let url: URL;
  try {
    url = new URL(secret.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (failed) url.pathname = `${url.pathname.replace(/\/$/, '')}/fail`;
  return url.toString();
}

/**
 * Pings the heartbeat URL, with a few numbers from the tick as the body (Healthchecks.io
 * shows it in the check's log). Never throws, and never logs the URL: it is a secret.
 */
export async function pingHeartbeat(
  fetch: FetchFn,
  secret: string | undefined,
  outcome: { stats: TickStats } | { error: string },
  log: (entry: Record<string, unknown>) => void,
): Promise<void> {
  const failed = 'error' in outcome;
  const url = heartbeatUrl(secret, failed);
  if (url === null) return;
  const body = failed
    ? `tick failed: ${outcome.error}`.slice(0, 1000)
    : JSON.stringify({
        checked: outcome.stats.checked,
        failures: outcome.stats.failures,
        rowsWritten: outcome.stats.rowsWritten.total,
        durationMs: outcome.stats.durationMs,
      });
  try {
    const response = await fetch(url, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    if (!response.ok) log({ event: 'heartbeat_failed', status: response.status });
  } catch (error) {
    log({ event: 'heartbeat_failed', error: String(error) });
  }
}
