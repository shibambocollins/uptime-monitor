import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  backoffMs,
  deliverDueAlerts,
  type DeliverDeps,
  LEASE_MS,
  MAX_ATTEMPTS,
} from '../src/alerts/deliver';
import { alertMessage, duration, MAX_CONTENT_LENGTH } from '../src/alerts/message';
import { encryptConfig } from '../src/channels/secrets';
import { checkGroup } from '../src/checker/group';
import type { FetchFn } from '../src/checker/run-checks';
import { runTick } from '../src/checker/tick';
import { resetDb } from './fixtures';

const T0 = Date.UTC(2026, 10, 27, 17, 0, 0);
const MINUTE = 60_000;
const KEY = env.CHANNEL_ENCRYPTION_KEY;
const hook = (n: number) =>
  `https://discord.com/api/webhooks/1000000000000000${n}/token-${n}-${'x'.repeat(30)}`;

// --- Fixtures ---

let teamId: number;
let monitorId: number;

const run = (sql: string, ...values: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...values)
    .run();
const id = async (sql: string, ...values: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...values)
    .first<{ id: number }>())!.id;
const all = async <T = Record<string, unknown>>(sql: string, ...values: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...values)
      .all<T>()
  ).results;

async function addChannel(n: number, extra: { enabled?: 0 | 1 } = {}) {
  return id(
    `INSERT INTO notification_channels
       (team_id, type, name, config_encrypted, hint, enabled, created_at, updated_at)
     VALUES (?1, 'DISCORD', ?2, ?3, 'xxxx', ?4, 0, 0) RETURNING id`,
    teamId,
    `channel ${n}`,
    await encryptConfig(KEY, teamId, { url: hook(n) }),
    extra.enabled ?? 1,
  );
}

/** An incident with its DOWN alert queued for the given channels, due at `due`. */
async function queueAlert(
  type: 'DOWN' | 'RECOVERED',
  channels: number[],
  due = T0,
  incident?: number,
) {
  const incidentId =
    incident ??
    (await id(
      // Resolved, so tests can add several (only one may be open per monitor); delivery
      // doesn't look at resolved_at.
      `INSERT INTO incidents (monitor_id, started_at, resolved_at, cause)
       VALUES (?1, ?2, ?2, 'unexpected status 503') RETURNING id`,
      monitorId,
      T0 - 10 * MINUTE,
    ));
  const eventId = await id(
    `INSERT INTO alert_events (monitor_id, incident_id, type, created_at) VALUES (?1, ?2, ?3, ?4)
     RETURNING id`,
    monitorId,
    incidentId,
    type,
    type === 'DOWN' ? T0 - 10 * MINUTE : T0,
  );
  for (const channel of channels) {
    await run(
      `INSERT INTO alert_deliveries (event_id, channel_id, next_attempt_at) VALUES (?1, ?2, ?3)`,
      eventId,
      channel,
      due,
    );
  }
  return { incidentId, eventId };
}

beforeEach(async () => {
  await resetDb();
  teamId = await id(`INSERT INTO teams (name, created_at) VALUES ('A', 0) RETURNING id`);
  const projectId = await id(
    `INSERT INTO projects (team_id, name, created_at, updated_at) VALUES (?1, 'Shop', 0, 0)
     RETURNING id`,
    teamId,
  );
  monitorId = await id(
    `INSERT INTO monitors (project_id, name, url, interval_seconds, next_run_at, created_at,
       updated_at)
     VALUES (?1, 'Checkout', 'https://shop.example.com/pay?token=secret', 60, ?2, 0, 0)
     RETURNING id`,
    projectId,
    T0,
  );
});

// --- A fake Discord: status per webhook URL ---

function fakeDiscord(statusFor: (url: string) => number | Response = () => 204) {
  const sent: { url: string; content: string }[] = [];
  const fetch: FetchFn = async (url, init) => {
    sent.push({ url, content: JSON.parse(init.body as string).content });
    const answer = statusFor(url);
    return answer instanceof Response ? answer : new Response(null, { status: answer });
  };
  return { fetch, sent };
}

function deps(fetch: FetchFn, overrides: Partial<DeliverDeps> = {}): DeliverDeps {
  return {
    db: env.DB,
    fetch,
    now: () => T0,
    encryptionKey: KEY,
    deadline: T0 + 50_000,
    ...overrides,
  };
}

const deliveries = () =>
  all(
    `SELECT event_id, channel_id, status, attempts, next_attempt_at, last_error, sent_at
     FROM alert_deliveries ORDER BY event_id, channel_id`,
  );

// --- Tests ---

describe('alertMessage', () => {
  const facts = {
    monitorName: 'Checkout',
    projectName: 'Shop',
    url: 'https://shop.example.com/pay?token=secret',
    cause: 'unexpected status 503',
    startedAt: Date.UTC(2026, 10, 27, 15, 4),
  };

  it('says what is down, why, and since when, without the query string', () => {
    expect(alertMessage({ ...facts, type: 'DOWN', at: facts.startedAt })).toBe(
      [
        '🔴 **Checkout** is DOWN',
        'Shop · https://shop.example.com/pay',
        'Cause: unexpected status 503',
        'Since 2026-11-27 15:04 UTC',
      ].join('\n'),
    );
  });

  it('says how long the outage lasted on recovery', () => {
    expect(alertMessage({ ...facts, type: 'RECOVERED', at: facts.startedAt + 125 * MINUTE })).toBe(
      [
        '🟢 **Checkout** is back UP after 2 h 5 min',
        'Shop · https://shop.example.com/pay',
        'Down from 2026-11-27 15:04 UTC to 2026-11-27 17:09 UTC',
      ].join('\n'),
    );
  });

  it("stays within Discord's 2000 characters", () => {
    const long = alertMessage({ ...facts, type: 'DOWN', at: 0, cause: 'x'.repeat(5000) });
    expect(long.length).toBe(MAX_CONTENT_LENGTH);
  });

  it.each([
    [45_000, '45 s'],
    [3 * MINUTE, '3 min'],
    [60 * MINUTE, '1 h'],
    [27 * 60 * MINUTE, '1 d 3 h'],
  ])('formats %i ms as %s', (ms, text) => {
    expect(duration(ms)).toBe(text);
  });
});

describe('deliverDueAlerts', () => {
  it('sends a due alert to the decrypted webhook and marks it sent', async () => {
    const channel = await addChannel(1);
    const { eventId } = await queueAlert('DOWN', [channel]);
    const discord = fakeDiscord();

    const stats = await deliverDueAlerts(deps(discord.fetch));

    expect(stats).toMatchObject({ claimed: 1, sent: 1, failed: 0, retried: 0 });
    expect(discord.sent).toEqual([
      { url: hook(1), content: expect.stringContaining('**Checkout** is DOWN') },
    ]);
    expect(await deliveries()).toEqual([
      {
        event_id: eventId,
        channel_id: channel,
        status: 'SENT',
        attempts: 1,
        next_attempt_at: T0 + LEASE_MS,
        last_error: null,
        sent_at: T0,
      },
    ]);
    // Nothing left to do.
    expect((await deliverDueAlerts(deps(discord.fetch))).claimed).toBe(0);
  });

  it('leaves deliveries that are not due yet', async () => {
    await queueAlert('DOWN', [await addChannel(1)], T0 + MINUTE);
    const discord = fakeDiscord();
    expect((await deliverDueAlerts(deps(discord.fetch))).claimed).toBe(0);
    expect(discord.sent).toEqual([]);
  });

  it('retries with exponential backoff and gives up after MAX_ATTEMPTS', async () => {
    const channel = await addChannel(1);
    await queueAlert('DOWN', [channel]);
    const discord = fakeDiscord(() => 503);

    let now = T0;
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      const stats = await deliverDueAlerts(
        deps(discord.fetch, { now: () => now, deadline: now + 50_000 }),
      );
      expect(stats.retried, `attempt ${attempt}`).toBe(1);
      const [row] = await deliveries();
      expect(row).toMatchObject({
        status: 'PENDING',
        attempts: attempt,
        next_attempt_at: now + backoffMs(attempt),
        last_error: 'Discord unavailable (503)',
      });
      now += backoffMs(attempt);
    }
    await deliverDueAlerts(deps(discord.fetch, { now: () => now, deadline: now + 50_000 }));
    expect(await deliveries()).toEqual([
      expect.objectContaining({ status: 'FAILED', attempts: MAX_ATTEMPTS }),
    ]);
    expect(discord.sent).toHaveLength(MAX_ATTEMPTS);
    expect([1, 2, 3, 7, 8].map(backoffMs)).toEqual([
      MINUTE,
      2 * MINUTE,
      4 * MINUTE,
      60 * MINUTE,
      60 * MINUTE,
    ]);
  });

  it("waits as long as Discord's 429 says", async () => {
    await queueAlert('DOWN', [await addChannel(1)]);
    const discord = fakeDiscord(() => Response.json({ retry_after: 2.5 }, { status: 429 }));
    await deliverDueAlerts(deps(discord.fetch));
    expect(await deliveries()).toEqual([
      expect.objectContaining({
        status: 'PENDING',
        next_attempt_at: T0 + 2500,
        last_error: 'rate limited by Discord',
      }),
    ]);
  });

  it('marks the channel broken on 404 and fails its other alerts without sending them', async () => {
    const broken = await addChannel(1);
    const working = await addChannel(2);
    await queueAlert('DOWN', [broken, working]);
    await queueAlert('DOWN', [broken]);
    const discord = fakeDiscord((url) => (url === hook(1) ? 404 : 204));

    const stats = await deliverDueAlerts(deps(discord.fetch));

    expect(stats).toMatchObject({ claimed: 3, sent: 1, failed: 2, channelsBroken: 1 });
    // One call to the broken webhook, not two; the working channel was not held up.
    expect(discord.sent.map((s) => s.url)).toEqual([hook(1), hook(2)]);
    expect(
      await all(`SELECT id, broken_at, broken_reason FROM notification_channels ORDER BY id`),
    ).toEqual([
      { id: broken, broken_at: T0, broken_reason: expect.stringContaining('404') },
      { id: working, broken_at: null, broken_reason: null },
    ]);
    expect((await deliveries()).map((d) => [d.channel_id, d.status])).toEqual([
      [broken, 'FAILED'],
      [working, 'SENT'],
      [broken, 'FAILED'],
    ]);
  });

  it('fails deliveries to a disabled channel without sending', async () => {
    await queueAlert('DOWN', [await addChannel(1, { enabled: 0 })]);
    const discord = fakeDiscord();
    await deliverDueAlerts(deps(discord.fetch));
    expect(discord.sent).toEqual([]);
    expect(await deliveries()).toEqual([
      expect.objectContaining({ status: 'FAILED', last_error: 'channel disabled' }),
    ]);
  });

  it('holds RECOVERED until the DOWN alert to that channel has gone out', async () => {
    const channel = await addChannel(1);
    const { incidentId } = await queueAlert('DOWN', [channel], T0 + MINUTE); // retrying
    await queueAlert('RECOVERED', [channel], T0, incidentId);
    const discord = fakeDiscord();

    expect((await deliverDueAlerts(deps(discord.fetch))).claimed).toBe(0);

    const later = T0 + MINUTE;
    await deliverDueAlerts(deps(discord.fetch, { now: () => later, deadline: later + 50_000 }));
    await deliverDueAlerts(deps(discord.fetch, { now: () => later, deadline: later + 50_000 }));
    expect(discord.sent.map((s) => s.content.slice(0, 2))).toEqual(['🔴', '🟢']);
  });

  it('does not hand a claimed delivery to an overlapping run', async () => {
    await queueAlert('DOWN', [await addChannel(1)]);
    let release!: () => void;
    const slow: FetchFn = () =>
      new Promise((resolve) => {
        release = () => resolve(new Response(null, { status: 204 }));
      });
    const first = deliverDueAlerts(deps(slow));
    await new Promise((r) => setTimeout(r, 50)); // let the first run claim and start sending
    const second = await deliverDueAlerts(deps(fakeDiscord().fetch));
    expect(second.claimed).toBe(0);
    release();
    expect((await first).sent).toBe(1);
  });

  it('releases what it cannot send before the deadline, without counting an attempt', async () => {
    await queueAlert('DOWN', [await addChannel(1)]);
    const discord = fakeDiscord();
    const stats = await deliverDueAlerts(deps(discord.fetch, { deadline: T0 + 5_000 }));
    expect(stats).toMatchObject({ claimed: 1, released: 1, sent: 0 });
    expect(discord.sent).toEqual([]);
    expect(await deliveries()).toEqual([
      expect.objectContaining({ status: 'PENDING', attempts: 0, next_attempt_at: T0 }),
    ]);
  });

  it('sends at most `limit` per run', async () => {
    const channel = await addChannel(1);
    for (let i = 0; i < 3; i++) await queueAlert('DOWN', [channel]);
    const discord = fakeDiscord();
    expect((await deliverDueAlerts(deps(discord.fetch), 2)).sent).toBe(2);
    expect(discord.sent).toHaveLength(2);
  });

  it('fails, without sending, when the channel config cannot be decrypted', async () => {
    await queueAlert('DOWN', [await addChannel(1)]);
    const discord = fakeDiscord();
    const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    await deliverDueAlerts(deps(discord.fetch, { encryptionKey: otherKey }));
    expect(discord.sent).toEqual([]);
    expect(await deliveries()).toEqual([
      expect.objectContaining({
        status: 'FAILED',
        last_error: 'could not decrypt the channel config',
      }),
    ]);
  });
});

describe('the tick sends alerts', () => {
  const tick = (now: number, fetch: FetchFn, deliver?: (deadline: number) => Promise<never>) =>
    runTick(now, {
      db: env.DB,
      runGroup: (group) => checkGroup(group, { db: env.DB, fetch, now: () => now }),
      deliverAlerts:
        deliver ?? ((deadline) => deliverDueAlerts(deps(fetch, { now: () => now, deadline }))),
      now: () => now,
      log: (entry) => logs.push(entry),
      tickId: 'test',
      maxChecks: 40,
    });
  let logs: Record<string, unknown>[];
  beforeEach(() => {
    logs = [];
  });

  it('in the same tick the monitor goes DOWN', async () => {
    await addChannel(1);
    // The monitor answers 503; Discord answers 204.
    const fetch: FetchFn = async (url, init) =>
      url.startsWith('https://discord.com/')
        ? (fakeDiscordCalls.push(JSON.parse(init.body as string).content),
          new Response(null, { status: 204 }))
        : new Response(null, { status: 503 });
    const fakeDiscordCalls: string[] = [];

    const stats = [];
    for (let i = 0; i < 3; i++) stats.push(await tick(T0 + i * MINUTE, fetch));

    expect(fakeDiscordCalls).toEqual([expect.stringContaining('**Checkout** is DOWN')]);
    expect(stats[2]!.deliveries).toMatchObject({ claimed: 1, sent: 1 });
    expect(stats[2]!.rowsWritten.delivery).toBeGreaterThan(0);
    // Quiet ticks with nothing queued: one claim query, no rows written.
    expect(stats[0]!.rowsWritten.delivery).toBe(0);
  });

  it('only starts AlertSender when something is due', async () => {
    let calls = 0;
    await tick(
      T0,
      async () => new Response(null, { status: 200 }),
      async () => {
        calls++;
        throw new Error('should not be called');
      },
    );
    expect(calls).toBe(0);
  });

  it('logs a delivery failure and still records the tick', async () => {
    await queueAlert('DOWN', [await addChannel(1)]);
    const stats = await tick(
      T0,
      async () => new Response(null, { status: 200 }),
      async () => {
        throw new Error('AlertSender crashed');
      },
    );
    expect(stats.checked).toBe(1);
    expect(stats.deliveries).toBeNull();
    expect(logs).toContainEqual(expect.objectContaining({ event: 'alert_delivery_failed' }));
    expect(await all(`SELECT ticks FROM usage_daily`)).toEqual([{ ticks: 1 }]);
  });
});

describe('AlertSender', () => {
  it('runs as its own entrypoint and reports plain stats', async () => {
    // Nothing queued, so no network is needed.
    expect(await exports.AlertSender.deliver(Date.now() + 50_000)).toEqual({
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      released: 0,
      channelsBroken: 0,
      rowsWritten: 0,
    });
  });
});
