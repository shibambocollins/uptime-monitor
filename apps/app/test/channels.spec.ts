import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { createSession } from '../src/auth/sessions';
import { upsertGithubUser } from '../src/auth/users';
import { parseDiscordWebhook, sendDiscordMessage } from '../src/channels/discord';
import { MAX_CHANNELS_PER_TEAM, TEST_MESSAGE } from '../src/channels/routes';
import { decryptConfig, EncryptionKeyError, encryptConfig } from '../src/channels/secrets';
import type { FetchFn } from '../src/checker/run-checks';
import { resetDb } from './fixtures';

const T0 = Date.UTC(2026, 10, 27, 16, 0, 0);
const KEY = env.CHANNEL_ENCRYPTION_KEY;
const ID = '112233445566778899';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIjKlMnOpQrStUvWxYz0123';
const WEBHOOK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;

// --- A fake Discord ---

interface Sent {
  url: string;
  init: RequestInit;
}

let sent: Sent[];
let discordStatus: number;
let discordDown: boolean;
const discord: FetchFn = async (url, init) => {
  sent.push({ url, init });
  if (discordDown) throw new TypeError('Network connection lost.');
  return new Response(null, { status: discordStatus });
};

const app = createApp({
  fetch: discord,
  now: () => T0,
  rateLimit: async () => true,
  checkHost: async () => ({ ok: true, addresses: [] }),
});

// --- People ---

interface Person {
  userId: number;
  teamId: number;
  cookie: string;
}
let alice: Person; // OWNER of team A
let bob: Person; // OWNER of team B
let carol: Person; // VIEWER in team A

async function person(githubId: number, login: string): Promise<Person> {
  const { userId } = await upsertGithubUser(
    env.DB,
    { id: githubId, login, name: null, avatarUrl: null },
    T0,
  );
  const team = await env.DB.prepare(`SELECT team_id FROM team_members WHERE user_id = ?1`)
    .bind(userId)
    .first<{ team_id: number }>();
  const { token } = await createSession(env.DB, userId, T0);
  return { userId, teamId: team!.team_id, cookie: `__Host-session=${token}` };
}

beforeEach(async () => {
  sent = [];
  discordStatus = 204;
  discordDown = false;
  await resetDb();
  alice = await person(1, 'alice');
  bob = await person(2, 'bob');
  carol = await person(3, 'carol');
  await env.DB.prepare(
    `INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?1, ?2, 'VIEWER', ?3)`,
  )
    .bind(alice.teamId, carol.userId, T0)
    .run();
});

function call(who: Person, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { Cookie: who.cookie };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(
    `/api/v1${path}`,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
}

// `any`: the tests assert exact shapes with toEqual, which checks more than a type would.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (response: Response): Promise<Record<string, any>> => response.json();

async function addChannel(who: Person = alice, webhookUrl = WEBHOOK) {
  const response = await call(who, 'POST', `/teams/${who.teamId}/channels`, {
    type: 'DISCORD',
    name: 'Ops',
    webhookUrl,
  });
  expect(response.status).toBe(201);
  return (await json(response)).channel as { id: number };
}

const channelRow = (id: number) =>
  env.DB.prepare(`SELECT * FROM notification_channels WHERE id = ?1`)
    .bind(id)
    .first<Record<string, unknown>>();

// --- Tests ---

describe('parseDiscordWebhook', () => {
  it.each([
    WEBHOOK,
    `https://discordapp.com/api/webhooks/${ID}/${TOKEN}`,
    `https://canary.discord.com/api/webhooks/${ID}/${TOKEN}`,
    `https://ptb.discord.com/api/webhooks/${ID}/${TOKEN}`,
    `https://discord.com/api/v10/webhooks/${ID}/${TOKEN}`,
    `https://discord.com/api/webhooks/${ID}/${TOKEN}/`,
    `https://discord.com/api/webhooks/${ID}/${TOKEN}?thread_id=1`,
    `  ${WEBHOOK}  `,
  ])('accepts %s, rebuilt on discord.com', (input) => {
    expect(parseDiscordWebhook(input)).toEqual({ url: WEBHOOK, hint: TOKEN.slice(-4) });
  });

  it.each([
    `http://discord.com/api/webhooks/${ID}/${TOKEN}`,
    `https://discord.com.evil.example/api/webhooks/${ID}/${TOKEN}`,
    `https://evil.example/api/webhooks/${ID}/${TOKEN}`,
    `https://discord.com:8443/api/webhooks/${ID}/${TOKEN}`,
    `https://user:pass@discord.com/api/webhooks/${ID}/${TOKEN}`,
    `https://discord.com/api/webhooks/${ID}`,
    `https://discord.com/api/webhooks/not-a-number/${TOKEN}`,
    `https://discord.com/api/webhooks/${ID}/short`,
    `https://discord.com/api/webhooks/${ID}/${TOKEN}/slack`,
    `https://discord.com/channels/${ID}/${ID}`,
    'not a url',
  ])('rejects %s', (input) => {
    expect(parseDiscordWebhook(input)).toBeNull();
  });
});

describe('channel config encryption (AES-GCM)', () => {
  it('round-trips, with a fresh IV each time, and never stores the plaintext', async () => {
    const a = await encryptConfig(KEY, 7, { url: WEBHOOK });
    const b = await encryptConfig(KEY, 7, { url: WEBHOOK });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(a).not.toContain(TOKEN);
    expect(await decryptConfig(KEY, 7, a)).toEqual({ url: WEBHOOK });
  });

  it('refuses a ciphertext moved to another team, altered, or read with another key', async () => {
    const stored = await encryptConfig(KEY, 7, { url: WEBHOOK });
    await expect(decryptConfig(KEY, 8, stored)).rejects.toThrow();
    const flipped = stored.slice(0, -2) + (stored.endsWith('A') ? 'B' : 'A') + stored.slice(-1);
    await expect(decryptConfig(KEY, 7, flipped)).rejects.toThrow();
    const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
    await expect(decryptConfig(otherKey, 7, stored)).rejects.toThrow();
  });

  it.each([undefined, '', 'not base64!', btoa('too short')])(
    'rejects the key %s as a deploy error',
    async (key) => {
      await expect(encryptConfig(key, 7, {})).rejects.toThrow(EncryptionKeyError);
    },
  );
});

describe('sendDiscordMessage', () => {
  const answer =
    (response: () => Response): FetchFn =>
    async (url, init) => {
      sent.push({ url, init });
      return response();
    };

  it('posts plain JSON that cannot ping anyone, without following redirects', async () => {
    expect(await sendDiscordMessage(discord, WEBHOOK, 'hello @everyone')).toEqual({ ok: true });
    const [{ url, init }] = sent as [Sent];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      content: 'hello @everyone',
      allowed_mentions: { parse: [] },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([404, 401])('reports %i as a webhook that is gone', async (status) => {
    const fetch = answer(() => new Response(null, { status }));
    expect(await sendDiscordMessage(fetch, WEBHOOK, 'x')).toEqual({
      ok: false,
      kind: 'gone',
      status,
    });
  });

  it('reads the wait from a 429, preferring the body’s retry_after', async () => {
    const withBody = answer(() =>
      Response.json({ retry_after: 1.5 }, { status: 429, headers: { 'Retry-After': '9' } }),
    );
    expect(await sendDiscordMessage(withBody, WEBHOOK, 'x')).toEqual({
      ok: false,
      kind: 'rate_limited',
      retryAfterMs: 1500,
    });
    const headerOnly = answer(
      () => new Response('', { status: 429, headers: { 'Retry-After': '3' } }),
    );
    expect(await sendDiscordMessage(headerOnly, WEBHOOK, 'x')).toMatchObject({
      retryAfterMs: 3000,
    });
  });

  it('reports 5xx, redirects and network errors as unavailable', async () => {
    const error = answer(() => new Response(null, { status: 502 }));
    expect(await sendDiscordMessage(error, WEBHOOK, 'x')).toEqual({
      ok: false,
      kind: 'unavailable',
      status: 502,
    });
    const redirect = answer(() => new Response(null, { status: 302, headers: { Location: '/' } }));
    expect(await sendDiscordMessage(redirect, WEBHOOK, 'x')).toMatchObject({ kind: 'unavailable' });
    discordDown = true;
    expect(await sendDiscordMessage(discord, WEBHOOK, 'x')).toEqual({
      ok: false,
      kind: 'unavailable',
      status: null,
    });
  });
});

describe('channels API', () => {
  let logs: unknown[];
  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => logs.push(args));
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('verifies with a test message, stores the URL encrypted, and only ever shows a hint', async () => {
    const response = await call(alice, 'POST', `/teams/${alice.teamId}/channels`, {
      type: 'DISCORD',
      name: 'Ops',
      webhookUrl: `https://discordapp.com/api/webhooks/${ID}/${TOKEN}`,
    });
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).channel).toEqual({
      id: expect.any(Number),
      teamId: alice.teamId,
      type: 'DISCORD',
      name: 'Ops',
      hint: TOKEN.slice(-4),
      enabled: true,
      verifiedAt: T0,
      brokenAt: null,
      brokenReason: null,
      createdAt: T0,
      updatedAt: T0,
    });

    // The test message went to the canonical discord.com URL.
    expect(sent.map((s) => [s.url, JSON.parse(s.init.body as string).content])).toEqual([
      [WEBHOOK, TEST_MESSAGE],
    ]);
    const row = await channelRow(JSON.parse(text).channel.id);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(await decryptConfig(KEY, alice.teamId, row!.config_encrypted as string)).toEqual({
      url: WEBHOOK,
    });

    const list = await json(await call(alice, 'GET', `/teams/${alice.teamId}/channels`));
    expect(JSON.stringify(list)).not.toContain(TOKEN);
    expect(list.channels).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it('rejects a URL that is not a Discord webhook without sending anything', async () => {
    for (const webhookUrl of ['https://hooks.slack.com/services/x', 'http://127.0.0.1/']) {
      const response = await call(alice, 'POST', `/teams/${alice.teamId}/channels`, {
        type: 'DISCORD',
        name: 'Ops',
        webhookUrl,
      });
      expect(response.status).toBe(400);
      expect((await json(response)).error.details).toEqual([
        { field: 'webhookUrl', message: expect.any(String) },
      ]);
    }
    expect(sent).toEqual([]);
  });

  it('does not save a webhook Discord rejects, or one it could not check', async () => {
    discordStatus = 404;
    const rejected = await call(alice, 'POST', `/teams/${alice.teamId}/channels`, {
      type: 'DISCORD',
      name: 'Ops',
      webhookUrl: WEBHOOK,
    });
    expect([rejected.status, (await json(rejected)).error.code]).toEqual([400, 'WEBHOOK_REJECTED']);

    discordDown = true;
    const down = await call(alice, 'POST', `/teams/${alice.teamId}/channels`, {
      type: 'DISCORD',
      name: 'Ops',
      webhookUrl: WEBHOOK,
    });
    expect([down.status, (await json(down)).error.code]).toEqual([502, 'DISCORD_UNAVAILABLE']);
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM notification_channels`).first()).toEqual(
      {
        n: 0,
      },
    );
  });

  it(`stops at ${MAX_CHANNELS_PER_TEAM} channels per team, before messaging Discord`, async () => {
    for (let i = 0; i < MAX_CHANNELS_PER_TEAM; i++) await addChannel();
    sent = [];
    const response = await call(alice, 'POST', `/teams/${alice.teamId}/channels`, {
      type: 'DISCORD',
      name: 'One more',
      webhookUrl: WEBHOOK,
    });
    expect([response.status, (await json(response)).error.code]).toEqual([409, 'LIMIT_REACHED']);
    expect(sent).toEqual([]);
  });

  it('renames and disables without contacting Discord; a new webhook is verified again', async () => {
    const channel = await addChannel();
    await env.DB.prepare(
      `UPDATE notification_channels SET broken_at = 1, broken_reason = 'x'`,
    ).run();
    sent = [];

    const renamed = await call(alice, 'PATCH', `/channels/${channel.id}`, {
      name: 'On-call',
      enabled: false,
    });
    expect((await json(renamed)).channel).toMatchObject({
      name: 'On-call',
      enabled: false,
      brokenAt: 1,
    });
    expect(sent).toEqual([]);

    const otherToken = TOKEN.replace(/^AbCd/, 'ZyXw').replace(/0123$/, '9876');
    const replaced = await call(alice, 'PATCH', `/channels/${channel.id}`, {
      webhookUrl: `https://discord.com/api/webhooks/${ID}/${otherToken}`,
    });
    expect((await json(replaced)).channel).toMatchObject({
      hint: '9876',
      brokenAt: null,
      brokenReason: null,
      verifiedAt: T0,
    });
    expect(sent).toHaveLength(1);
  });

  it('marks a channel broken when its test finds the webhook gone, and fixes it when it works', async () => {
    const channel = await addChannel();
    discordStatus = 404;
    const failed = await call(alice, 'POST', `/channels/${channel.id}/test`);
    expect(failed.status).toBe(400);
    expect(await channelRow(channel.id)).toMatchObject({
      broken_at: T0,
      broken_reason: expect.stringContaining('404'),
    });

    discordStatus = 204;
    const ok = await call(alice, 'POST', `/channels/${channel.id}/test`);
    expect((await json(ok)).channel).toMatchObject({ brokenAt: null, verifiedAt: T0 });
    expect(sent.at(-1)!.url).toBe(WEBHOOK);
  });

  it('deletes a channel with its queued deliveries', async () => {
    const channel = await addChannel();
    const project = await env.DB.prepare(
      `INSERT INTO projects (team_id, name, created_at, updated_at) VALUES (?1, 'P', 0, 0) RETURNING id`,
    )
      .bind(alice.teamId)
      .first<{ id: number }>();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO monitors (id, project_id, name, url, created_at, updated_at)
         VALUES (900, ?1, 'M', 'https://x.example/', 0, 0)`,
      ).bind(project!.id),
      env.DB.prepare(`INSERT INTO incidents (id, monitor_id, started_at) VALUES (900, 900, 0)`),
      env.DB.prepare(
        `INSERT INTO alert_events (id, monitor_id, incident_id, type, created_at)
         VALUES (900, 900, 900, 'DOWN', 0)`,
      ),
      env.DB.prepare(
        `INSERT INTO alert_deliveries (event_id, channel_id, next_attempt_at) VALUES (900, ?1, 0)`,
      ).bind(channel.id),
    ]);

    expect((await call(alice, 'DELETE', `/channels/${channel.id}`)).status).toBe(204);
    expect((await call(alice, 'GET', `/channels/${channel.id}`)).status).toBe(404);
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM alert_deliveries`).first()).toEqual({
      n: 0,
    });
  });

  it('lets a VIEWER list channels but not change them', async () => {
    const channel = await addChannel();
    expect((await call(carol, 'GET', `/teams/${alice.teamId}/channels`)).status).toBe(200);
    const writes = [
      call(carol, 'POST', `/teams/${alice.teamId}/channels`, {
        type: 'DISCORD',
        name: 'X',
        webhookUrl: WEBHOOK,
      }),
      call(carol, 'PATCH', `/channels/${channel.id}`, { name: 'X' }),
      call(carol, 'POST', `/channels/${channel.id}/test`),
      call(carol, 'DELETE', `/channels/${channel.id}`),
    ];
    for (const response of await Promise.all(writes)) expect(response.status).toBe(403);
  });

  it('answers 404 to another team on every route, and changes nothing', async () => {
    const channel = await addChannel();
    sent = [];
    const before = await channelRow(channel.id);
    const attempts: [string, string, unknown?][] = [
      ['GET', `/teams/${alice.teamId}/channels`],
      [
        'POST',
        `/teams/${alice.teamId}/channels`,
        { type: 'DISCORD', name: 'X', webhookUrl: WEBHOOK },
      ],
      ['GET', `/channels/${channel.id}`],
      ['PATCH', `/channels/${channel.id}`, { name: 'Mine' }],
      ['POST', `/channels/${channel.id}/test`],
      ['DELETE', `/channels/${channel.id}`],
    ];
    for (const [method, path, body] of attempts) {
      const response = await call(bob, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(await channelRow(channel.id)).toEqual(before);
    expect(sent).toEqual([]);
  });
});

describe('a broken encryption key on the server', () => {
  it('says so, and sends nothing for a channel it cannot save', async () => {
    const response = await app.request(
      `/api/v1/teams/${alice.teamId}/channels`,
      {
        method: 'POST',
        headers: { Cookie: alice.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'DISCORD', name: 'Alerts', webhookUrl: WEBHOOK }),
      },
      { ...env, CHANNEL_ENCRYPTION_KEY: 'not-32-bytes' },
    );
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'SERVER_MISCONFIGURED',
    );
    expect(sent).toEqual([]);
    const { n } = (await env.DB.prepare(`SELECT count(*) AS n FROM notification_channels`).first<{
      n: number;
    }>())!;
    expect(n).toBe(0);
  });
});
