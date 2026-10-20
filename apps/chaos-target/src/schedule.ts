export type Phase = 'UP' | 'DOWN' | 'SLOW' | 'FLAPPING';

export interface PhaseSpec {
  phase: Phase;
  minutes: number;
}

/** A phase occurrence in epoch milliseconds; `end` is exclusive. */
export interface PhaseWindow {
  phase: Phase;
  start: number;
  end: number;
}

export const MINUTE_MS = 60_000;

/**
 * One 2-hour cycle, repeated forever and anchored to the Unix epoch, so every restart
 * agrees on the current phase without storing anything.
 *
 * DOWN lasts 20 minutes so a monitor checking every 5 minutes with N=3 (about 15 minutes
 * to detect) still catches it. FLAPPING alternates every minute and should never alert.
 */
export const DEFAULT_CYCLE: readonly PhaseSpec[] = [
  { phase: 'UP', minutes: 60 },
  { phase: 'DOWN', minutes: 20 },
  { phase: 'UP', minutes: 10 },
  { phase: 'SLOW', minutes: 15 },
  { phase: 'UP', minutes: 5 },
  { phase: 'FLAPPING', minutes: 10 },
];

export function cycleLengthMs(cycle: readonly PhaseSpec[]): number {
  return cycle.reduce((total, spec) => total + spec.minutes * MINUTE_MS, 0);
}

export function phaseAt(time: number, cycle: readonly PhaseSpec[] = DEFAULT_CYCLE): PhaseWindow {
  const length = cycleLengthMs(cycle);
  if (length <= 0) {
    throw new Error('cycle must have a positive total length');
  }
  let start = Math.floor(time / length) * length;
  for (const spec of cycle) {
    const end = start + spec.minutes * MINUTE_MS;
    if (time < end) {
      return { phase: spec.phase, start, end };
    }
    start = end;
  }
  throw new Error('unreachable: time always falls inside its own cycle');
}

/** Every phase window overlapping [from, to), in order. */
export function phasesBetween(
  from: number,
  to: number,
  cycle: readonly PhaseSpec[] = DEFAULT_CYCLE,
): PhaseWindow[] {
  const windows: PhaseWindow[] = [];
  if (from >= to) {
    return windows;
  }
  let window = phaseAt(from, cycle);
  while (window.start < to) {
    windows.push(window);
    window = phaseAt(window.end, cycle);
  }
  return windows;
}

/**
 * During FLAPPING, odd minutes are down and even minutes are up. Checks 1 or 5 minutes
 * apart therefore alternate, so N=3 consecutive failures never happens.
 */
export function isFlapDown(time: number): boolean {
  return Math.floor(time / MINUTE_MS) % 2 === 1;
}
