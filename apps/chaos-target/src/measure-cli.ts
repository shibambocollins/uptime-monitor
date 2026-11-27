// Prints how the live monitor did against chaos-target's schedule (src/measure.ts).
//
//   npm run measure -w apps/chaos-target            # the last 24 hours
//   npm run measure -w apps/chaos-target -- 48      # the last 48 hours (at most 168)
//
// Reads only: the public /schedule endpoint and two SELECTs on the remote D1 database,
// through the repository's own wrangler (you must be logged in: `npx wrangler login`).

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure, report, type IncidentRow } from './measure.ts';
import type { PhaseWindow } from './schedule.ts';

const BASE = 'https://uptime-chaos-target.onrender.com';
/** The monitor to score: the one pointed at the scheduled endpoint. */
const MONITOR_URL = `${BASE}/scheduled`;

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '../../app');
const wrangler = path.join(here, '../../../node_modules/wrangler/bin/wrangler.js');

/** Runs one read-only query on the remote database. Values are numbers we computed. */
function query<T>(sql: string): T[] {
  const out = execFileSync(
    process.execPath,
    [wrangler, 'd1', 'execute', 'uptime', '--remote', '--json', '--command', sql],
    { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return (JSON.parse(out) as { results: T[] }[])[0]!.results;
}

const hours = Math.min(Math.max(Number(process.argv[2] ?? 24) || 24, 1), 168);
const now = Date.now();
const from = now - hours * 3_600_000;

const response = await fetch(
  `${BASE}/schedule?from=${new Date(from).toISOString()}&to=${new Date(now).toISOString()}`,
  { signal: AbortSignal.timeout(90_000) }, // Render may need a minute to wake it
);
if (!response.ok) throw new Error(`/schedule answered ${response.status}`);
const schedule = (await response.json()) as {
  bootedAt: string;
  windows: { phase: PhaseWindow['phase']; start: string; end: string }[];
};
const windows = schedule.windows.map((w) => ({
  phase: w.phase,
  start: Date.parse(w.start),
  end: Date.parse(w.end),
}));

// The URL is a constant above, not input, so building the SQL text is safe here.
const monitor = `(SELECT id FROM monitors WHERE url = '${MONITOR_URL}')`;
const incidents = query<{
  started_at: number;
  resolved_at: number | null;
  alert_sent_at: number | null;
}>(
  `SELECT i.started_at, i.resolved_at,
     (SELECT MIN(d.sent_at) FROM alert_events AS e
      JOIN alert_deliveries AS d ON d.event_id = e.id
      WHERE e.incident_id = i.id AND e.type = 'DOWN') AS alert_sent_at
   FROM incidents AS i WHERE i.monitor_id IN ${monitor} AND i.started_at >= ${from}
   ORDER BY i.started_at`,
).map((r): IncidentRow => ({
  startedAt: r.started_at,
  resolvedAt: r.resolved_at,
  alertSentAt: r.alert_sent_at,
}));
// A slow check that moves the monitor to DEGRADED is stored as an event (a state change).
const slowSince = query<{ checked_at: number }>(
  `SELECT checked_at FROM check_events
   WHERE monitor_id IN ${monitor} AND state = 'DEGRADED' AND success = 1 AND checked_at >= ${from}
   ORDER BY checked_at`,
).map((r) => r.checked_at);

console.log(`chaos-target, last ${hours} h (it last restarted at ${schedule.bootedAt})\n`);
console.log(report(measure(windows, incidents, slowSince, now)));
