import { describe, expect, it } from 'vitest';
import {
  cycleLengthMs,
  DEFAULT_CYCLE,
  isFlapDown,
  MINUTE_MS,
  phaseAt,
  phasesBetween,
} from './schedule.ts';

const min = (n: number) => n * MINUTE_MS;
const CYCLE = cycleLengthMs(DEFAULT_CYCLE);

describe('DEFAULT_CYCLE', () => {
  it('lasts 2 hours', () => {
    expect(CYCLE).toBe(min(120));
  });

  it('keeps DOWN long enough for a 5-minute monitor with N=3 to detect it', () => {
    const down = DEFAULT_CYCLE.find((spec) => spec.phase === 'DOWN');
    expect(down?.minutes).toBeGreaterThan(15);
  });
});

describe('phaseAt', () => {
  it.each([
    [0, 'UP'],
    [59, 'UP'],
    [60, 'DOWN'],
    [79, 'DOWN'],
    [80, 'UP'],
    [90, 'SLOW'],
    [105, 'UP'],
    [110, 'FLAPPING'],
    [119, 'FLAPPING'],
    [120, 'UP'],
  ])('minute %i of the cycle is %s', (minute, phase) => {
    expect(phaseAt(min(minute)).phase).toBe(phase);
  });

  it('returns the window boundaries, with end exclusive', () => {
    expect(phaseAt(min(65))).toEqual({ phase: 'DOWN', start: min(60), end: min(80) });
    expect(phaseAt(min(80)).phase).toBe('UP');
  });

  it('repeats every cycle, anchored to the epoch', () => {
    const later = 1000 * CYCLE;
    expect(phaseAt(later + min(65))).toEqual({
      phase: 'DOWN',
      start: later + min(60),
      end: later + min(80),
    });
  });

  it('works for times before the epoch', () => {
    expect(phaseAt(-min(1)).phase).toBe('FLAPPING');
  });

  it('rejects a cycle with no length', () => {
    expect(() => phaseAt(0, [])).toThrow();
    expect(() => phaseAt(0, [{ phase: 'UP', minutes: 0 }])).toThrow();
  });
});

describe('phasesBetween', () => {
  it('lists every window overlapping the range, including partial ones', () => {
    const windows = phasesBetween(min(70), min(95));
    expect(windows.map((w) => w.phase)).toEqual(['DOWN', 'UP', 'SLOW']);
    expect(windows[0]?.start).toBe(min(60));
    expect(windows.at(-1)?.end).toBe(min(105));
  });

  it('crosses into the next cycle', () => {
    const windows = phasesBetween(min(115), min(125));
    expect(windows.map((w) => w.phase)).toEqual(['FLAPPING', 'UP']);
  });

  it('returns nothing for an empty range', () => {
    expect(phasesBetween(min(10), min(10))).toEqual([]);
  });
});

describe('isFlapDown', () => {
  it('is down on odd minutes and up on even minutes', () => {
    expect(isFlapDown(min(110))).toBe(false);
    expect(isFlapDown(min(111))).toBe(true);
    expect(isFlapDown(min(111) + 59_999)).toBe(true);
  });

  it.each([1, 5])('never gives 3 failures in a row to checks %i minute(s) apart', (gap) => {
    const results = [0, 1, 2].map((i) => isFlapDown(min(110 + i * gap)));
    expect(results.every(Boolean)).toBe(false);
  });
});
