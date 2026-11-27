import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createSession } from '../src/auth/sessions';
import { checkGroup } from '../src/checker/group';
import type { FetchFn } from '../src/checker/run-checks';
import { runTick, type TickStats } from '../src/checker/tick';
import { resetDb } from './fixtures';

// Incidents and the alert outbox, written by the checker (migrations/0003_alerts.sql).

const T0 = Date.UTC(2026, 10, 27, 15, 0, 0);
const MINUTE = 60_000;

let teamId: number;
let otherTeamId: number;
let monitorId: number;

const run = (sql: string, ...values: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...values)
    .run();
const insertId = async (sql: string, ...values: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...values)
    .first<{ id: number }>())!.id;
const all = async <T = Record<string, unknown>>(sql: string, ...values: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...values)
      .all<T>()
  ).results;

async function addTeam(name: string) {
  return insertId(`INSERT INTO teams (name, created_at) VALUES (?1, ?2) RETURNING id`, name, T0);
}

async function addChannel(team: number, extra: { enabled?: 0 | 1; broken_at?: number } = {}) {
  return insertId(
    `INSERT INTO notification_channels
       (team_id, type, name, config_encrypted, hint, enabled, broken_at, created_at, updated_at)
     VALUES (?1, 'DISCORD', 'ops', 'ciphertext', 'abcd', ?2, ?3, ?4, ?4) RETURNING id`,
    team,
    extra.enabled ?? 1,
    extra.broken_at ?? null,
    T0,
  );
}

beforeEach(async () => {
  await resetDb();
  teamId = await addTeam('A');
  otherTeamId = await addTeam('B');
  const projectId = await insertId(
    `INSERT INTO projects (team_id, name, created_at, updated_at) VALUES (?1, 'P', ?2, ?2)
     RETURNING id`,
    teamId,
    T0,
  );
  monitorId = await insertId(
    `INSERT INTO monitors (project_id, name, url, interval_seconds, next_run_at, created_at,
       updated_at)
     VALUES (?1, 'M', 'https://target.example/', 60, ?2, ?2, ?2) RETURNING id`,
    projectId,
    T0,
  );
});

const respond =
  (status: number): FetchFn =>
  async () =>
    new Response(null, { status });

/** One tick a minute, starting at `start`, each answered with the given status. */
async function ticks(start: number, ...statuses: number[]): Promise<TickStats[]> {
  const stats = [];
  for (const [i, status] of statuses.entries()) {
    const now = start + i * MINUTE;
    stats.push(
      await runTick(now, {
        db: env.DB,
        runGroup: (group) =>
          checkGroup(group, { db: env.DB, fetch: respond(status), now: () => now }),
        now: () => now,
        log: () => {},
        tickId: 'test',
        maxChecks: 40,
      }),
    );
  }
  return stats;
}

describe('incidents', () => {
  it('opens one when the monitor goes DOWN, with the cause, and closes it on recovery', async () => {
    await ticks(T0, 503, 503, 503);
    expect(await all(`SELECT monitor_id, started_at, resolved_at, cause FROM incidents`)).toEqual([
      {
        monitor_id: monitorId,
        started_at: T0 + 2 * MINUTE,
        resolved_at: null,
        cause: 'unexpected status 503',
      },
    ]);

    // Still failing: no new incident and no new alert.
    await ticks(T0 + 3 * MINUTE, 503, 503);
    expect(await all(`SELECT id FROM incidents`)).toHaveLength(1);
    expect(await all(`SELECT type FROM alert_events`)).toEqual([{ type: 'DOWN' }]);

    // DOWN -> UP takes two successes (DEFAULT_POLICY).
    await ticks(T0 + 5 * MINUTE, 200, 200);
    expect(await all(`SELECT resolved_at FROM incidents`)).toEqual([
      { resolved_at: T0 + 6 * MINUTE },
    ]);
    expect(await all(`SELECT type, created_at FROM alert_events ORDER BY id`)).toEqual([
      { type: 'DOWN', created_at: T0 + 2 * MINUTE },
      { type: 'RECOVERED', created_at: T0 + 6 * MINUTE },
    ]);
  });

  it('opens a new incident for the next outage', async () => {
    await ticks(T0, 503, 503, 503, 200, 200, 503, 503, 503);
    expect(await all(`SELECT resolved_at IS NULL AS open FROM incidents ORDER BY id`)).toEqual([
      { open: 0 },
      { open: 1 },
    ]);
    expect((await all(`SELECT type FROM alert_events ORDER BY id`)).map((r) => r.type)).toEqual([
      'DOWN',
      'RECOVERED',
      'DOWN',
    ]);
  });

  it('closes an incident left open by a state reset before opening the next one', async () => {
    await run(
      `INSERT INTO incidents (monitor_id, started_at) VALUES (?1, ?2)`,
      monitorId,
      T0 - 60 * MINUTE,
    );
    await ticks(T0, 503, 503, 503);
    expect(await all(`SELECT started_at, resolved_at FROM incidents ORDER BY id`)).toEqual([
      { started_at: T0 - 60 * MINUTE, resolved_at: T0 + 2 * MINUTE },
      { started_at: T0 + 2 * MINUTE, resolved_at: null },
    ]);
    expect(await all(`SELECT type FROM alert_events`)).toEqual([{ type: 'DOWN' }]);
  });

  it('opens no incident for slowness (UP <-> DEGRADED)', async () => {
    await run(`UPDATE monitors SET latency_threshold_ms = 1 WHERE id = ?1`, monitorId);
    let clock = T0;
    const slow: FetchFn = async () => {
      clock += 50; // every response takes 50 ms
      return new Response(null, { status: 200 });
    };
    for (let i = 0; i < 4; i++) {
      const now = T0 + i * MINUTE;
      clock = now;
      await runTick(now, {
        db: env.DB,
        runGroup: (group) => checkGroup(group, { db: env.DB, fetch: slow, now: () => clock }),
        now: () => now,
        log: () => {},
        tickId: 'test',
        maxChecks: 40,
      });
    }
    expect(await all(`SELECT state FROM monitors`)).toEqual([{ state: 'DEGRADED' }]);
    expect(await all(`SELECT id FROM incidents`)).toEqual([]);
    expect(await all(`SELECT id FROM alert_events`)).toEqual([]);
  });
});

describe('alert outbox', () => {
  it('queues each alert for every enabled, working channel of the team, due at once', async () => {
    const ops = await addChannel(teamId);
    const oncall = await addChannel(teamId);
    await addChannel(teamId, { enabled: 0 });
    await addChannel(teamId, { broken_at: T0 });
    await addChannel(otherTeamId); // another team's channel never hears about this monitor

    await ticks(T0, 503, 503, 503);

    const [down] = await all<{ id: number }>(`SELECT id FROM alert_events WHERE type = 'DOWN'`);
    expect(
      await all(
        `SELECT event_id, channel_id, status, attempts, next_attempt_at FROM alert_deliveries
         ORDER BY channel_id`,
      ),
    ).toEqual([
      {
        event_id: down!.id,
        channel_id: ops,
        status: 'PENDING',
        attempts: 0,
        next_attempt_at: T0 + 2 * MINUTE,
      },
      {
        event_id: down!.id,
        channel_id: oncall,
        status: 'PENDING',
        attempts: 0,
        next_attempt_at: T0 + 2 * MINUTE,
      },
    ]);

    await ticks(T0 + 3 * MINUTE, 200, 200);
    expect(
      await all(
        `SELECT e.type, d.channel_id FROM alert_deliveries AS d
         JOIN alert_events AS e ON e.id = d.event_id ORDER BY e.id, d.channel_id`,
      ),
    ).toEqual([
      { type: 'DOWN', channel_id: ops },
      { type: 'DOWN', channel_id: oncall },
      { type: 'RECOVERED', channel_id: ops },
      { type: 'RECOVERED', channel_id: oncall },
    ]);
  });

  it('still records the event when the team has no channels yet', async () => {
    await ticks(T0, 503, 503, 503);
    expect(await all(`SELECT type FROM alert_events`)).toEqual([{ type: 'DOWN' }]);
    expect(await all(`SELECT * FROM alert_deliveries`)).toEqual([]);
  });

  it('writes nothing extra on steady checks, and a handful of rows on a transition', async () => {
    await addChannel(teamId);
    const stats = await ticks(T0, 503, 503, 503, 503, 200, 200, 200);
    const alertRows = stats.map((s) => s.rowsWritten.alert);
    // Only the DOWN tick (3rd) and the recovery tick (6th) write alert rows. Measured
    // locally: DOWN 9 (incident, event, delivery: each its row and 2 index entries);
    // RECOVERED 7 (event 3, delivery 3, closing the incident 1).
    expect(alertRows).toEqual([0, 0, 9, 0, 0, 7, 0]);
    // The healthy check afterwards is back to the 2-row budget (claim + rollup).
    expect(stats[6]!.rowsWritten.total).toBe(2);
  });

  it('is removed with its monitor', async () => {
    await addChannel(teamId);
    await ticks(T0, 503, 503, 503);
    await run(`DELETE FROM monitors WHERE id = ?1`, monitorId);
    for (const table of ['incidents', 'alert_events', 'alert_deliveries']) {
      expect(await all(`SELECT * FROM ${table}`), table).toEqual([]);
    }
  });
});

describe('changing a monitor URL through the API', () => {
  it('ends the open incident without a RECOVERED alert', async () => {
    const userId = await insertId(
      `INSERT INTO users (github_id, login, created_at, updated_at) VALUES (1, 'a', ?1, ?1)
       RETURNING id`,
      T0,
    );
    await run(
      `INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?1, ?2, 'OWNER', ?3)`,
      teamId,
      userId,
      T0,
    );
    const { token } = await createSession(env.DB, userId, T0);
    await ticks(T0, 503, 503, 503);

    const later = T0 + 10 * MINUTE;
    const app = createApp({
      fetch: async () => new Response(null, { status: 599 }),
      now: () => later,
      rateLimit: async () => true,
      checkHost: async () => ({ ok: true, addresses: ['93.184.215.14'] }),
    });
    const response = await app.request(
      `/api/v1/monitors/${monitorId}`,
      {
        method: 'PATCH',
        headers: { Cookie: `__Host-session=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://new.example.com/' }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(await all(`SELECT resolved_at FROM incidents`)).toEqual([{ resolved_at: later }]);
    expect(await all(`SELECT type FROM alert_events`)).toEqual([{ type: 'DOWN' }]);
  });
});
