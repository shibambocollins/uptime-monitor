import type { ClaimedMonitor } from './claim';

export const USER_AGENT = 'HealthMonitor/1.0';

/** Workers free plan: 6 connections waiting for response headers at once (CLAUDE.md §5). */
export const MAX_CONCURRENT_CHECKS = 6;

const MAX_ERROR_LENGTH = 200;

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface CheckDeps {
  fetch: FetchFn;
  now: () => number;
}

export interface CheckResult {
  monitorId: number;
  /** When the request started, epoch ms. */
  checkedAt: number;
  success: boolean;
  statusCode: number | null;
  /** Time to response headers. Null when no response arrived. */
  responseMs: number | null;
  error: string | null;
}

/** Never throws: every failure becomes a failed CheckResult. */
export async function runCheck(monitor: ClaimedMonitor, deps: CheckDeps): Promise<CheckResult> {
  const checkedAt = deps.now();
  try {
    const response = await deps.fetch(monitor.url, {
      method: 'GET',
      // A redirect is reported as its own status. Following it would need every Location
      // re-validated against the SSRF rules (CLAUDE.md §8), which arrive with the monitor API.
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(monitor.timeoutMs),
    });
    const responseMs = deps.now() - checkedAt;
    // Only the status matters. Cancelling the body frees the connection for the next check.
    await response.body?.cancel();
    const success = response.status === monitor.expectedStatus;
    return {
      monitorId: monitor.id,
      checkedAt,
      success,
      statusCode: response.status,
      responseMs,
      error: success ? null : `unexpected status ${response.status}`,
    };
  } catch (error) {
    return {
      monitorId: monitor.id,
      checkedAt,
      success: false,
      statusCode: null,
      responseMs: null,
      error: describeError(error),
    };
  }
}

/**
 * Runs the checks at most `concurrency` at a time. Each check starts its own timer when its
 * request starts, so time spent waiting for a free slot is not counted as latency.
 * Results come back in the same order as `monitors`.
 */
export async function runChecks(
  monitors: readonly ClaimedMonitor[],
  deps: CheckDeps,
  concurrency = MAX_CONCURRENT_CHECKS,
): Promise<CheckResult[]> {
  const results = new Array<CheckResult>(monitors.length);
  let next = 0;
  const worker = async () => {
    while (next < monitors.length) {
      const index = next++;
      results[index] = await runCheck(monitors[index] as ClaimedMonitor, deps);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, monitors.length) }, worker));
  return results;
}

function describeError(error: unknown): string {
  // AbortSignal.timeout() rejects with a DOMException; don't rely on it extending Error.
  if (typeof error === 'object' && error !== null && 'name' in error) {
    if (error.name === 'TimeoutError') return 'timeout';
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}
