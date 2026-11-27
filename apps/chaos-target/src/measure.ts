// Scores the monitor against chaos-target's own schedule (the ground truth from /schedule):
// how long each planned outage took to detect and to alert on, which outages were missed,
// and which incidents were false alarms (above all during FLAPPING, which must never alert).
// Pure, so it is tested without the network; src/measure-cli.ts feeds it live data.

import type { PhaseWindow } from './schedule.ts';

/** An incident detected after a window ends still belongs to it if it starts this soon. */
export const GRACE_MS = 10 * 60_000;

export interface IncidentRow {
  startedAt: number;
  resolvedAt: number | null;
  /** When the DOWN alert reached Discord, or null if it was never sent. */
  alertSentAt: number | null;
}

export interface DownResult {
  window: PhaseWindow;
  /** From the outage starting to the incident opening (the third failed check). */
  detectMs: number | null;
  /** From the outage starting to the Discord message being sent. */
  alertMs: number | null;
  /** From the outage ending to the incident closing. */
  recoverMs: number | null;
}

export interface SlowResult {
  window: PhaseWindow;
  detectMs: number | null;
}

export interface Measurement {
  down: DownResult[];
  missed: number;
  falseAlerts: IncidentRow[];
  /** The false alerts that started during a FLAPPING window. */
  flappingAlerts: number;
  slow: SlowResult[];
}

const inWindow = (time: number, window: PhaseWindow, grace = 0) =>
  time >= window.start && time < window.end + grace;

/**
 * Only windows that ended at least GRACE_MS before `now` are scored, so an outage still in
 * progress (or just over) doesn't count as missed.
 */
export function measure(
  windows: readonly PhaseWindow[],
  incidents: readonly IncidentRow[],
  slowSince: readonly number[],
  now: number,
): Measurement {
  const done = windows.filter((w) => w.end + GRACE_MS <= now);
  const matched = new Set<IncidentRow>();

  const down = done
    .filter((w) => w.phase === 'DOWN')
    .map((window): DownResult => {
      const incident = incidents.find(
        (i) => !matched.has(i) && inWindow(i.startedAt, window, GRACE_MS),
      );
      if (!incident) return { window, detectMs: null, alertMs: null, recoverMs: null };
      matched.add(incident);
      return {
        window,
        detectMs: incident.startedAt - window.start,
        alertMs: incident.alertSentAt === null ? null : incident.alertSentAt - window.start,
        recoverMs: incident.resolvedAt === null ? null : incident.resolvedAt - window.end,
      };
    });

  const scoredFrom = done[0]?.start ?? now;
  const scoredTo = done.at(-1)?.end ?? now;
  const falseAlerts = incidents.filter(
    (i) => !matched.has(i) && i.startedAt >= scoredFrom && i.startedAt < scoredTo,
  );
  const flappingAlerts = falseAlerts.filter((i) =>
    done.some((w) => w.phase === 'FLAPPING' && inWindow(i.startedAt, w)),
  ).length;

  const slow = done
    .filter((w) => w.phase === 'SLOW')
    .map((window): SlowResult => {
      const first = slowSince.find((t) => inWindow(t, window));
      return { window, detectMs: first === undefined ? null : first - window.start };
    });

  return {
    down,
    missed: down.filter((d) => d.detectMs === null).length,
    falseAlerts,
    flappingAlerts,
    slow,
  };
}

/** The middle value (the lower one of the two for an even count), or null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/** "2 min 46 s", "45 s". */
export function minutes(ms: number | null): string {
  if (ms === null) return '–';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** A Markdown summary, ready to paste into the README. */
export function report(m: Measurement): string {
  const detect = m.down.flatMap((d) => (d.detectMs === null ? [] : [d.detectMs]));
  const alert = m.down.flatMap((d) => (d.alertMs === null ? [] : [d.alertMs]));
  const slowFound = m.slow.filter((s) => s.detectMs !== null).length;
  const lines = [
    '| Measure | Result |',
    '|---|---|',
    `| Planned outages | ${m.down.length} |`,
    `| Detected | ${m.down.length - m.missed} (missed ${m.missed}) |`,
    `| Time to detect | median ${minutes(median(detect))}, worst ${minutes(detect.length ? Math.max(...detect) : null)} |`,
    `| Time to Discord alert | median ${minutes(median(alert))}, worst ${minutes(alert.length ? Math.max(...alert) : null)} |`,
    `| False alerts | ${m.falseAlerts.length} (${m.flappingAlerts} during flapping) |`,
    `| Slow phases flagged | ${slowFound} of ${m.slow.length} |`,
    '',
    '| Outage started (UTC) | Detected after | Alert after | Recovery noticed after |',
    '|---|---|---|---|',
    ...m.down.map(
      (d) =>
        `| ${new Date(d.window.start).toISOString().slice(0, 16).replace('T', ' ')} | ${minutes(d.detectMs)} | ${minutes(d.alertMs)} | ${minutes(d.recoverMs)} |`,
    ),
  ];
  return lines.join('\n');
}
