import type { MonitorState } from './monitor-state';

/** What one check found. SLOW means the expected response arrived, but above the threshold. */
export type CheckOutcome = 'OK' | 'SLOW' | 'FAIL';

export interface MonitorStatus {
  state: MonitorState;
  consecutiveFailures: number;
  consecutiveSlow: number;
  consecutiveSuccesses: number;
}

export interface StatePolicy {
  /** N consecutive failures: UP or DEGRADED to DOWN. */
  failuresToDown: number;
  /** N consecutive slow checks: UP to DEGRADED. */
  slowToDegraded: number;
  /** M consecutive good checks: DOWN (any success) or DEGRADED (fast only) to UP. */
  successesToUp: number;
}

export const DEFAULT_POLICY: StatePolicy = {
  failuresToDown: 3,
  slowToDegraded: 3,
  successesToUp: 2,
};

export interface Transition {
  from: MonitorState;
  to: MonitorState;
}

export interface StepResult {
  status: MonitorStatus;
  transition: Transition | null;
}

/**
 * Applies one check to a monitor (CLAUDE.md §6).
 *
 * Counters only count towards a pending transition and reset when it happens, so a
 * monitor that stays UP and fast (or DEGRADED and slow, or DOWN and failing) keeps all
 * three at 0. That matters for the D1 write budget (CLAUDE.md §5): the monitor row is
 * rewritten only when this function returns a different status.
 */
export function applyCheck(
  current: MonitorStatus,
  outcome: CheckOutcome,
  policy: StatePolicy = DEFAULT_POLICY,
): StepResult {
  switch (current.state) {
    case 'UP':
      if (outcome === 'FAIL') {
        const failures = current.consecutiveFailures + 1;
        return failures >= policy.failuresToDown
          ? move(current.state, 'DOWN')
          : stay(current.state, { consecutiveFailures: failures });
      }
      if (outcome === 'SLOW') {
        const slow = current.consecutiveSlow + 1;
        return slow >= policy.slowToDegraded
          ? move(current.state, 'DEGRADED')
          : stay(current.state, { consecutiveSlow: slow });
      }
      return stay(current.state, {});

    case 'DEGRADED':
      if (outcome === 'FAIL') {
        const failures = current.consecutiveFailures + 1;
        return failures >= policy.failuresToDown
          ? move(current.state, 'DOWN')
          : stay(current.state, { consecutiveFailures: failures });
      }
      if (outcome === 'OK') {
        const successes = current.consecutiveSuccesses + 1;
        return successes >= policy.successesToUp
          ? move(current.state, 'UP')
          : stay(current.state, { consecutiveSuccesses: successes });
      }
      return stay(current.state, {});

    case 'DOWN':
      if (outcome === 'FAIL') {
        return stay(current.state, {});
      }
      {
        const successes = current.consecutiveSuccesses + 1;
        return successes >= policy.successesToUp
          ? move(current.state, 'UP')
          : stay(current.state, { consecutiveSuccesses: successes });
      }
  }
}

/** True when the monitor row needs rewriting. */
export function statusChanged(a: MonitorStatus, b: MonitorStatus): boolean {
  return (
    a.state !== b.state ||
    a.consecutiveFailures !== b.consecutiveFailures ||
    a.consecutiveSlow !== b.consecutiveSlow ||
    a.consecutiveSuccesses !== b.consecutiveSuccesses
  );
}

const ZERO = { consecutiveFailures: 0, consecutiveSlow: 0, consecutiveSuccesses: 0 };

/** Any counter not named is reset: a streak only survives while it keeps growing. */
function stay(state: MonitorState, counters: Partial<typeof ZERO>): StepResult {
  return { status: { state, ...ZERO, ...counters }, transition: null };
}

function move(from: MonitorState, to: MonitorState): StepResult {
  return { status: { state: to, ...ZERO }, transition: { from, to } };
}
