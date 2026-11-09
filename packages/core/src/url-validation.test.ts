import { describe, expect, it } from 'vitest';
import vectors from '../../../contract-tests/url-validation.json';
import {
  type BlockedCategory,
  ipBlockCategory,
  MAX_URL_LENGTH,
  type UrlCheck,
  validateMonitorUrl,
} from './url-validation';

// One case per blocked category (CLAUDE.md §8 rule 5), shared with any future port.
const urlCases = vectors.urls as { name: string; input: string; result: UrlCheck }[];
const addressCases = vectors.addresses as { ip: string; category: BlockedCategory | null }[];

describe('validateMonitorUrl (contract-tests/url-validation.json)', () => {
  it.each(urlCases)('$name', ({ input, result }) => {
    expect(validateMonitorUrl(input)).toEqual(result);
  });
});

describe('validateMonitorUrl', () => {
  it(`accepts a URL of exactly ${MAX_URL_LENGTH} characters and rejects a longer one`, () => {
    const base = 'https://example.com/';
    const atLimit = base + 'a'.repeat(MAX_URL_LENGTH - base.length);
    expect(validateMonitorUrl(atLimit)).toEqual({ ok: true, href: atLimit });
    expect(validateMonitorUrl(atLimit + 'a')).toEqual({ ok: false, reason: 'TOO_LONG' });
  });

  it('measures the length after normalisation (percent-encoding makes it longer)', () => {
    const base = 'https://example.com/';
    // Each inner space becomes %20 (trailing spaces would be trimmed, so they sit between
    // letters): 1,820 characters in, 3,020 in the href.
    const input = base + 'a b'.repeat(600);
    expect(input.length).toBeLessThan(MAX_URL_LENGTH);
    expect(validateMonitorUrl(input)).toEqual({ ok: false, reason: 'TOO_LONG' });
  });

  it('covers every blocked category at least once', () => {
    const all: BlockedCategory[] = [
      'unspecified',
      'loopback',
      'private',
      'link-local',
      'metadata',
      'cgnat',
      'documentation',
      'multicast',
      'reserved',
      'unique-local',
      'transition',
    ];
    const seen = new Set(
      urlCases.flatMap(({ result }) =>
        !result.ok && result.reason === 'BLOCKED_ADDRESS' ? [result.category] : [],
      ),
    );
    expect([...seen].sort()).toEqual([...all].sort());
  });
});

describe('ipBlockCategory (DNS answers)', () => {
  it.each(addressCases)('$ip -> $category', ({ ip, category }) => {
    expect(ipBlockCategory(ip)).toBe(category);
  });

  it.each([
    'example.com',
    '',
    '1.2.3',
    '256.0.0.1',
    '01.2.3.4',
    '1::2::3',
    '1:2:3:4:5:6:7:8:9',
    'fe80::1%eth0',
  ])('throws on %j, so a bad DNS answer is never treated as public', (ip) => {
    expect(() => ipBlockCategory(ip)).toThrow('not an IP address');
  });
});
