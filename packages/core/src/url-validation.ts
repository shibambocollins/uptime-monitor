/**
 * SSRF checks for monitor URLs, rules 1 and 2 of CLAUDE.md §8: run when a monitor is
 * created or its URL changes, and on every redirect `Location` (rule 4).
 *
 * What this cannot do: a hostname is checked by name only. Whether it resolves to a
 * private address is rule 3 (DNS-over-HTTPS, using `ipBlockCategory` on each answer), and
 * even that is a check, not a pin: DNS rebinding stays a documented gap. Cloudflare's
 * fetch() is the last line (Phase 0: private IP literals get 403, hostnames resolving to
 * private addresses get 530), but we reject first so the user gets a clear error.
 *
 * Pure: no Workers or Hono imports. `URL` is the WHATWG parser, in both Node and Workers.
 */

/** Longest accepted URL, after normalisation. A limit we chose, not a standard. */
export const MAX_URL_LENGTH = 2048;

export type BlockedCategory =
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'metadata'
  | 'cgnat'
  | 'documentation'
  | 'multicast'
  | 'reserved'
  | 'unique-local'
  | 'transition';

export type UrlCheck =
  | { ok: true; href: string }
  | {
      ok: false;
      reason:
        'INVALID_URL' | 'TOO_LONG' | 'UNSUPPORTED_SCHEME' | 'CREDENTIALS' | 'INTERNAL_HOSTNAME';
    }
  | { ok: false; reason: 'BLOCKED_ADDRESS'; category: BlockedCategory };

/**
 * Validates and normalises a monitor URL. On success `href` is what to store and fetch:
 * lower-case scheme and host, default port dropped, IP forms canonical, fragment removed.
 */
export function validateMonitorUrl(input: string): UrlCheck {
  if (input.length > MAX_URL_LENGTH) return { ok: false, reason: 'TOO_LONG' };

  // The WHATWG parser also turns odd IPv4 forms (2130706433, 0x7f.1, 0177.0.0.1) into
  // dotted decimal, so the range checks below see the address fetch() would use.
  const url = URL.parse(input);
  if (url === null) return { ok: false, reason: 'INVALID_URL' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'UNSUPPORTED_SCHEME' };
  }
  // Credentials in a URL would be stored and shown in plain text. If authenticated
  // checks are added later, they get their own encrypted field.
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'CREDENTIALS' };

  url.hash = '';
  if (url.href.length > MAX_URL_LENGTH) return { ok: false, reason: 'TOO_LONG' };

  const host = url.hostname;
  // The parser has already rejected malformed IP literals, so a bracketed host is valid
  // IPv6 and a dotted-decimal host is valid IPv4.
  const v6 = host.startsWith('[') ? parseIpv6(host.slice(1, -1)) : null;
  const v4 = v6 === null ? parseIpv4(host) : null;
  if (v6 !== null || v4 !== null) {
    const category = v6 !== null ? classifyIpv6(v6) : classifyIpv4(v4 as Ipv4);
    return category === null
      ? { ok: true, href: url.href }
      : { ok: false, reason: 'BLOCKED_ADDRESS', category };
  }

  if (isInternalHostname(host)) return { ok: false, reason: 'INTERNAL_HOSTNAME' };
  return { ok: true, href: url.href };
}

/**
 * The blocked range an address falls in, or null if it is public. For DNS answers
 * (rule 3), so it accepts any textual IPv4 or IPv6 form. Throws if `ip` is not an
 * address, so a caller cannot mistake garbage for "public".
 */
export function ipBlockCategory(ip: string): BlockedCategory | null {
  const v4 = parseIpv4(ip);
  if (v4 !== null) return classifyIpv4(v4);
  const v6 = parseIpv6(ip);
  if (v6 !== null) return classifyIpv6(v6);
  throw new Error(`not an IP address: ${JSON.stringify(ip)}`);
}

// --- Hostnames ---

/**
 * Suffixes used for private networks: `localhost` (RFC 6761), `local` (mDNS, RFC 6762),
 * `home.arpa` (RFC 8375), `internal` (reserved by ICANN for private use), and the names
 * RFC 6762 Appendix G lists as common private choices.
 */
const INTERNAL_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'home.arpa',
  'intranet',
  'private',
  'corp',
  'home',
  'lan',
];

function isInternalHostname(host: string): boolean {
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  // A single label ("intranet", "printer") only resolves through a local search domain.
  if (!name.includes('.')) return true;
  return INTERNAL_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

// --- IPv4 ---

type Ipv4 = [number, number, number, number];

/** Strict dotted decimal only (the form the URL parser and DNS answers produce). */
function parseIpv4(text: string): Ipv4 | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (match === null) return null;
  const octets = match.slice(1).map((part) => {
    // A leading zero is octal to some parsers, so the address is ambiguous.
    if (part.length > 1 && part.startsWith('0')) return NaN;
    return Number(part);
  });
  if (octets.some((o) => !(o <= 255))) return null;
  return octets as Ipv4;
}

/** Instance metadata services, checked before the ranges that contain them. */
const IPV4_METADATA = ['169.254.169.254', '100.100.100.200']; // AWS/GCP/Azure, Alibaba

/** [network, prefix length, category]. Special-purpose ranges from the IANA registry. */
const IPV4_BLOCKS: [string, number, BlockedCategory][] = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, 'transition'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'reserved'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'], // includes 255.255.255.255
];

const toInt = (ip: Ipv4) => ((ip[0] * 256 + ip[1]) * 256 + ip[2]) * 256 + ip[3];

const IPV4_RANGES = IPV4_BLOCKS.map(([network, prefix, category]) => ({
  base: toInt(parseIpv4(network) as Ipv4),
  size: 2 ** (32 - prefix),
  category,
}));

function classifyIpv4(ip: Ipv4): BlockedCategory | null {
  if (IPV4_METADATA.includes(ip.join('.'))) return 'metadata';
  const value = toInt(ip);
  const range = IPV4_RANGES.find((r) => value >= r.base && value < r.base + r.size);
  return range?.category ?? null;
}

// --- IPv6 ---

/** Eight 16-bit groups. */
type Ipv6 = number[];

/**
 * Any textual IPv6 form: compressed (`::`), full, or with a trailing dotted IPv4.
 * Zone IDs (`%eth0`) are rejected (they only make sense on the local link).
 */
function parseIpv6(text: string): Ipv6 | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = parseGroups(halves[0] as string, halves.length === 1);
  const tail = halves.length === 2 ? parseGroups(halves[1] as string, true) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** Colon-separated groups; the last may be dotted IPv4 when `lastMayBeIpv4`. */
function parseGroups(text: string, lastMayBeIpv4: boolean): number[] | null {
  if (text === '') return [];
  const parts = text.split(':');
  const groups: number[] = [];
  for (const [i, part] of parts.entries()) {
    if (lastMayBeIpv4 && i === parts.length - 1 && part.includes('.')) {
      const v4 = parseIpv4(part);
      if (v4 === null) return null;
      groups.push(v4[0] * 256 + v4[1], v4[2] * 256 + v4[3]);
    } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
      groups.push(parseInt(part, 16));
    } else {
      return null;
    }
  }
  return groups;
}

/** The IPv4 address in groups `at` and `at + 1`. */
const embeddedIpv4 = (ip: Ipv6, at: number): Ipv4 => {
  const hi = ip[at] as number;
  const lo = ip[at + 1] as number;
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
};

const startsWith = (ip: Ipv6, prefix: number[]) => prefix.every((group, i) => ip[i] === group);

function classifyIpv6(ip: Ipv6): BlockedCategory | null {
  // fd00:ec2::254, AWS's IPv6 metadata endpoint (inside fc00::/7).
  if (ip.join(':') === [0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254].join(':')) return 'metadata';

  if (startsWith(ip, [0, 0, 0, 0, 0])) {
    // ::ffff:a.b.c.d (IPv4-mapped) reaches the IPv4 address, so judge that address.
    if (ip[5] === 0xffff) return classifyIpv4(embeddedIpv4(ip, 6));
    if (ip[5] === 0) {
      if (ip[6] === 0 && ip[7] === 0) return 'unspecified';
      if (ip[6] === 0 && ip[7] === 1) return 'loopback';
      return 'reserved'; // ::a.b.c.d, the deprecated IPv4-compatible form
    }
  }
  // 64:ff9b::/96, NAT64: a gateway translates it to the embedded IPv4 address.
  if (startsWith(ip, [0x64, 0xff9b, 0, 0, 0, 0])) return classifyIpv4(embeddedIpv4(ip, 6));
  if (startsWith(ip, [0x64, 0xff9b, 1])) return 'transition'; // local-use NAT64

  // Only 2000::/3 is global unicast. Everything else is blocked, by type.
  const first = ip[0] as number;
  if ((first & 0xe000) !== 0x2000) {
    if ((first & 0xfe00) === 0xfc00) return 'unique-local'; // fc00::/7
    if ((first & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
    if ((first & 0xff00) === 0xff00) return 'multicast'; // ff00::/8
    return 'reserved'; // fec0::/10 site-local, 100::/64 discard, and the rest
  }
  if (startsWith(ip, [0x2001, 0xdb8])) return 'documentation'; // 2001:db8::/32
  if (first === 0x3fff && ((ip[1] as number) & 0xf000) === 0) {
    return 'documentation'; // 3fff::/20 (RFC 9637)
  }
  if (startsWith(ip, [0x2001, 0])) return 'transition'; // Teredo, 2001::/32
  // 2002::/16, 6to4: the next 32 bits are an IPv4 address the relay will reach.
  if (first === 0x2002) return classifyIpv4(embeddedIpv4(ip, 1));
  return null;
}
