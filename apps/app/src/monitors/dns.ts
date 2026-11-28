import { ipBlockCategory } from '@uptime/core';
import { type FetchFn, USER_AGENT } from '../checker/run-checks';

// SSRF, DNS check: when a monitor is created or its URL changes, resolve the hostname
// and reject it if any address is private. This is a check, not a pin: the name can be
// repointed later (DNS rebinding), a documented gap. Cloudflare's own outbound filtering
// still refuses private addresses at check time (measured 2026-10-21).

/** Cloudflare's DNS-over-HTTPS JSON API (docs: 1.1.1.1, "DNS over HTTPS", JSON format). */
const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const TIMEOUT_MS = 5_000;
const TYPE = { A: 1, AAAA: 28 } as const;
/** DNS response codes (RFC 1035 §4.1.1). */
const NOERROR = 0;
const NXDOMAIN = 3;

export type HostCheck =
  | { ok: true; addresses: string[] }
  /** NOT_FOUND: no A or AAAA records. UNAVAILABLE: the lookup itself failed. */
  | { ok: false; reason: 'NOT_FOUND' | 'BLOCKED_ADDRESS' | 'UNAVAILABLE' };

export type CheckHostFn = (hostname: string) => Promise<HostCheck>;

/**
 * Resolves A and AAAA for `hostname` and checks every answer. IP literals are skipped:
 * validateMonitorUrl has already checked them. Fails closed: if DNS can't be asked, the
 * caller rejects the change rather than accept an unchecked name.
 */
export async function checkHostDns(fetch: FetchFn, hostname: string): Promise<HostCheck> {
  if (isIpLiteral(hostname)) return { ok: true, addresses: [] };

  const answers = await Promise.all([query(fetch, hostname, 'A'), query(fetch, hostname, 'AAAA')]);
  if (answers.includes(null)) return { ok: false, reason: 'UNAVAILABLE' };
  const addresses = (answers as string[][]).flat();

  for (const address of addresses) {
    let category;
    try {
      category = ipBlockCategory(address);
    } catch {
      // An A or AAAA answer that isn't an address: don't trust the response.
      return { ok: false, reason: 'UNAVAILABLE' };
    }
    if (category !== null) return { ok: false, reason: 'BLOCKED_ADDRESS' };
  }
  return addresses.length > 0 ? { ok: true, addresses } : { ok: false, reason: 'NOT_FOUND' };
}

/** The addresses of one type; [] for NXDOMAIN or no records; null if the lookup failed. */
async function query(fetch: FetchFn, hostname: string, type: keyof typeof TYPE) {
  const url = `${DOH_URL}?name=${encodeURIComponent(hostname)}&type=${type}`;
  let body: unknown;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/dns-json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    body = await response.json();
  } catch {
    return null;
  }

  const { Status, Answer } = (body ?? {}) as { Status?: unknown; Answer?: unknown };
  if (Status === NXDOMAIN) return [];
  if (Status !== NOERROR) return null; // SERVFAIL, REFUSED, or not a DoH answer at all
  if (Answer === undefined) return [];
  if (!Array.isArray(Answer)) return null;
  // CNAME records in the chain come back too; only the final address records matter.
  return Answer.filter(
    (record): record is { data: string } =>
      typeof record === 'object' &&
      record !== null &&
      record.type === TYPE[type] &&
      typeof record.data === 'string',
  ).map((record) => record.data);
}

const isIpLiteral = (hostname: string) =>
  hostname.startsWith('[') || /^[0-9]+(\.[0-9]+){3}$/.test(hostname);
