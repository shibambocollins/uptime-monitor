/** Ordered from healthiest to least healthy, so the index doubles as severity. */
export const MONITOR_STATES = ['UP', 'DEGRADED', 'DOWN'] as const;

export type MonitorState = (typeof MONITOR_STATES)[number];

/**
 * Project health is the worst state among its monitors (CLAUDE.md §3).
 * Returns null for a project with no monitors: "no data" is not the same as UP.
 */
export function worstState(states: readonly MonitorState[]): MonitorState | null {
  let worst: MonitorState | null = null;
  for (const state of states) {
    if (worst === null || MONITOR_STATES.indexOf(state) > MONITOR_STATES.indexOf(worst)) {
      worst = state;
    }
  }
  return worst;
}
