import { describe, expect, it } from 'vitest';
import type { MonitorState } from './monitor-state';
import {
  applyCheck,
  type CheckOutcome,
  type MonitorStatus,
  statusChanged,
  type Transition,
} from './state-machine';

const fresh = (state: MonitorState): MonitorStatus => ({
  state,
  consecutiveFailures: 0,
  consecutiveSlow: 0,
  consecutiveSuccesses: 0,
});

/** Feeds outcomes in order and returns the final status plus every transition seen. */
function run(start: MonitorStatus, outcomes: CheckOutcome[]) {
  let status = start;
  const transitions: Transition[] = [];
  for (const outcome of outcomes) {
    const step = applyCheck(status, outcome);
    status = step.status;
    if (step.transition) transitions.push(step.transition);
  }
  return { status, transitions };
}

describe('applyCheck', () => {
  it('goes DOWN after 3 consecutive failures, not before', () => {
    expect(run(fresh('UP'), ['FAIL', 'FAIL']).status).toEqual({
      ...fresh('UP'),
      consecutiveFailures: 2,
    });
    expect(run(fresh('UP'), ['FAIL', 'FAIL', 'FAIL'])).toEqual({
      status: fresh('DOWN'),
      transitions: [{ from: 'UP', to: 'DOWN' }],
    });
  });

  it('never alerts on a single timeout: one success resets the failure streak', () => {
    const { status, transitions } = run(fresh('UP'), ['FAIL', 'FAIL', 'OK', 'FAIL', 'FAIL']);
    expect(transitions).toEqual([]);
    expect(status.consecutiveFailures).toBe(2);
  });

  it('recovers from DOWN after 2 consecutive successes, slow ones included', () => {
    expect(run(fresh('DOWN'), ['OK'])).toEqual({
      status: { ...fresh('DOWN'), consecutiveSuccesses: 1 },
      transitions: [],
    });
    expect(run(fresh('DOWN'), ['SLOW', 'OK'])).toEqual({
      status: fresh('UP'),
      transitions: [{ from: 'DOWN', to: 'UP' }],
    });
  });

  it('restarts the recovery streak when a failure interrupts it', () => {
    expect(run(fresh('DOWN'), ['OK', 'FAIL', 'OK']).status).toEqual({
      ...fresh('DOWN'),
      consecutiveSuccesses: 1,
    });
  });

  it('goes DEGRADED after 3 consecutive slow checks', () => {
    expect(run(fresh('UP'), ['SLOW', 'SLOW', 'SLOW'])).toEqual({
      status: fresh('DEGRADED'),
      transitions: [{ from: 'UP', to: 'DEGRADED' }],
    });
    expect(run(fresh('UP'), ['SLOW', 'SLOW', 'OK', 'SLOW']).transitions).toEqual([]);
  });

  it('leaves DEGRADED only after 2 consecutive fast checks', () => {
    expect(run(fresh('DEGRADED'), ['OK', 'SLOW', 'OK']).transitions).toEqual([]);
    expect(run(fresh('DEGRADED'), ['OK', 'OK'])).toEqual({
      status: fresh('UP'),
      transitions: [{ from: 'DEGRADED', to: 'UP' }],
    });
  });

  it('goes from DEGRADED to DOWN after 3 failures', () => {
    expect(run(fresh('DEGRADED'), ['FAIL', 'FAIL', 'FAIL']).transitions).toEqual([
      { from: 'DEGRADED', to: 'DOWN' },
    ]);
  });

  it('respects a custom policy', () => {
    const policy = { failuresToDown: 1, slowToDegraded: 1, successesToUp: 1 };
    expect(applyCheck(fresh('UP'), 'FAIL', policy).transition).toEqual({ from: 'UP', to: 'DOWN' });
    expect(applyCheck(fresh('DOWN'), 'OK', policy).transition).toEqual({ from: 'DOWN', to: 'UP' });
  });

  // The write budget depends on this (CLAUDE.md §5): steady states must not touch the row.
  it.each([
    ['UP', 'OK'],
    ['DEGRADED', 'SLOW'],
    ['DOWN', 'FAIL'],
  ] as const)('keeps a steady %s monitor unchanged on %s', (state, outcome) => {
    const before = fresh(state);
    const after = run(before, [outcome, outcome, outcome, outcome]).status;
    expect(statusChanged(before, after)).toBe(false);
  });
});

describe('statusChanged', () => {
  it('detects a change in state or in any counter', () => {
    expect(statusChanged(fresh('UP'), fresh('UP'))).toBe(false);
    expect(statusChanged(fresh('UP'), fresh('DOWN'))).toBe(true);
    expect(statusChanged(fresh('UP'), { ...fresh('UP'), consecutiveSlow: 1 })).toBe(true);
  });
});
