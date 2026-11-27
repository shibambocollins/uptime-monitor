import { describe, expect, it } from 'vitest';
import { GRACE_MS, measure, median, minutes, report, type IncidentRow } from './measure.ts';
import type { PhaseWindow } from './schedule.ts';

const MIN = 60_000;
const T = Date.UTC(2026, 10, 28, 0, 0, 0);
const w = (phase: PhaseWindow['phase'], from: number, to: number): PhaseWindow => ({
  phase,
  start: T + from * MIN,
  end: T + to * MIN,
});
// One 2-hour cycle (schedule.ts DEFAULT_CYCLE).
const CYCLE = [
  w('UP', 0, 60),
  w('DOWN', 60, 80),
  w('UP', 80, 90),
  w('SLOW', 90, 105),
  w('UP', 105, 110),
  w('FLAPPING', 110, 120),
];
const AFTER = T + 120 * MIN + GRACE_MS;
const incident = (start: number, end: number | null, alert: number | null): IncidentRow => ({
  startedAt: T + start * MIN,
  resolvedAt: end === null ? null : T + end * MIN,
  alertSentAt: alert === null ? null : T + alert * MIN,
});

describe('measure', () => {
  it('times detection, the alert and recovery from the outage start', () => {
    const m = measure(CYCLE, [incident(63, 82, 63.5)], [T + 92 * MIN], AFTER);
    expect(m.down).toEqual([
      { window: CYCLE[1], detectMs: 3 * MIN, alertMs: 3.5 * MIN, recoverMs: 2 * MIN },
    ]);
    expect(m).toMatchObject({ missed: 0, falseAlerts: [], flappingAlerts: 0 });
    expect(m.slow).toEqual([{ window: CYCLE[3], detectMs: 2 * MIN }]);
  });

  it('counts an outage with no incident as missed, and a slow phase never flagged', () => {
    const m = measure(CYCLE, [], [], AFTER);
    expect(m.missed).toBe(1);
    expect(m.down[0]!.detectMs).toBeNull();
    expect(m.slow[0]!.detectMs).toBeNull();
  });

  it('accepts an incident opened shortly after the outage ended', () => {
    const m = measure(CYCLE, [incident(85, 88, 85)], [], AFTER);
    expect(m.down[0]!.detectMs).toBe(25 * MIN);
    expect(m.falseAlerts).toEqual([]);
  });

  it('reports incidents outside outages as false alerts, flapping ones separately', () => {
    const early = incident(30, 35, 30);
    const flap = incident(112, 113, 112);
    const m = measure(CYCLE, [early, incident(62, 82, 62), flap], [], AFTER);
    expect(m.falseAlerts).toEqual([early, flap]);
    expect(m.flappingAlerts).toBe(1);
  });

  it('does not score windows that are still too recent', () => {
    const m = measure(CYCLE, [], [], T + 85 * MIN);
    expect(m.down).toEqual([]);
    expect(m.missed).toBe(0);
  });
});

describe('formatting', () => {
  it('takes the lower middle value as the median', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2);
  });

  it('writes durations in minutes and seconds', () => {
    expect(minutes(45_000)).toBe('45 s');
    expect(minutes(166_000)).toBe('2 min 46 s');
    expect(minutes(null)).toBe('–');
  });

  it('reports a Markdown table', () => {
    const text = report(measure(CYCLE, [incident(63, 82, 63.5)], [], AFTER));
    expect(text).toContain('| Detected | 1 (missed 0) |');
    expect(text).toContain('| Time to detect | median 3 min 0 s, worst 3 min 0 s |');
    expect(text).toContain('| 2026-11-28 01:00 | 3 min 0 s | 3 min 30 s | 2 min 0 s |');
  });
});
