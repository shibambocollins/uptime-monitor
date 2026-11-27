import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps, AppEnv } from '../app-env';
import { apiError, notFound, readOnly } from '../http/errors';
import { parseId, parseJsonBody } from '../http/validate';
import { canWrite, type Role, teamRole } from '../teams/access';
import { type DiscordWebhook, parseDiscordWebhook, sendDiscordMessage } from './discord';
import { decryptConfig, EncryptionKeyError, encryptConfig } from './secrets';

/** Alert channels per team. Each one gets a delivery row per alert, so keep it small. */
export const MAX_CHANNELS_PER_TEAM = 5;

export const TEST_MESSAGE =
  'Uptime Monitor is connected. This channel will get an alert when a monitor in your team goes down, and another when it recovers.';

interface ChannelRow {
  id: number;
  team_id: number;
  type: 'DISCORD' | 'EMAIL';
  name: string;
  config_encrypted: string;
  hint: string;
  enabled: 0 | 1;
  broken_at: number | null;
  broken_reason: string | null;
  verified_at: number | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS = `id, team_id, type, name, config_encrypted, hint, enabled, broken_at,
  broken_reason, verified_at, created_at, updated_at`;

/** Never includes the config: the webhook URL is a secret (CLAUDE.md §7). */
export const channelDto = (row: ChannelRow) => ({
  id: row.id,
  teamId: row.team_id,
  type: row.type,
  name: row.name,
  hint: row.hint,
  enabled: row.enabled === 1,
  verifiedAt: row.verified_at,
  brokenAt: row.broken_at,
  brokenReason: row.broken_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const name = z.string().trim().min(1).max(100);
const webhookUrl = z.string().max(500);
// DISCORD only for now. EMAIL is in the schema for later (CLAUDE.md §7).
const CreateChannel = z.strictObject({ type: z.literal('DISCORD'), name, webhookUrl });
const UpdateChannel = z
  .strictObject({ name, enabled: z.boolean(), webhookUrl })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change.');

/** Mounted at /api/v1 behind requireSession (app.ts). */
export function channelRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>();

  routes.get('/teams/:teamId/channels', async (c) => {
    const teamId = parseId(c.req.param('teamId'));
    if (teamId === null || (await teamRole(c.env.DB, c.var.user.userId, teamId)) === null) {
      return notFound(c);
    }
    const { results } = await c.env.DB.prepare(
      `SELECT ${COLUMNS} FROM notification_channels WHERE team_id = ?1 ORDER BY id`,
    )
      .bind(teamId)
      .all<ChannelRow>();
    return c.json({ channels: results.map(channelDto) });
  });

  routes.post('/teams/:teamId/channels', async (c) => {
    const teamId = parseId(c.req.param('teamId'));
    const role = teamId === null ? null : await teamRole(c.env.DB, c.var.user.userId, teamId);
    if (teamId === null || role === null) return notFound(c);
    if (!canWrite(role)) return readOnly(c);

    const body = await parseJsonBody(c, CreateChannel);
    if (!body.ok) return body.response;
    const webhook = parseDiscordWebhook(body.data.webhookUrl);
    if (!webhook) return badWebhook(c);

    // Checked before the test message, so a team at its cap doesn't get a message for a
    // channel that won't be saved. The INSERT checks again, against races.
    const existing = await c.env.DB.prepare(
      `SELECT count(*) AS n FROM notification_channels WHERE team_id = ?1`,
    )
      .bind(teamId)
      .first<{ n: number }>();
    if (existing!.n >= MAX_CHANNELS_PER_TEAM) return limitReached(c);

    // Encrypted before the test message: if the server's key is broken, nothing is sent
    // for a channel that can't be saved.
    const config = await encrypt(c, teamId, webhook);
    if (config instanceof Response) return config;
    const failed = await verify(c, deps, webhook);
    if (failed) return failed;

    const now = deps.now();
    const row = await c.env.DB.prepare(
      `INSERT INTO notification_channels
         (team_id, type, name, config_encrypted, hint, verified_at, created_at, updated_at)
       SELECT ?1, 'DISCORD', ?2, ?3, ?4, ?5, ?5, ?5
       WHERE (SELECT count(*) FROM notification_channels WHERE team_id = ?1) < ?6
       RETURNING ${COLUMNS}`,
    )
      .bind(teamId, body.data.name, config, webhook.hint, now, MAX_CHANNELS_PER_TEAM)
      .first<ChannelRow>();
    if (!row) return limitReached(c);
    console.log({ event: 'channel_created', channelId: row.id, teamId, userId: c.var.user.userId });
    return c.json({ channel: channelDto(row) }, 201);
  });

  routes.get('/channels/:channelId', async (c) => {
    const channel = await loadChannel(c);
    return channel ? c.json({ channel: channelDto(channel) }) : notFound(c);
  });

  routes.patch('/channels/:channelId', async (c) => {
    const channel = await loadChannel(c);
    if (!channel) return notFound(c);
    if (!canWrite(channel.role)) return readOnly(c);

    const body = await parseJsonBody(c, UpdateChannel);
    if (!body.ok) return body.response;

    const now = deps.now();
    const sets: string[] = ['updated_at = ?2'];
    const values: unknown[] = [channel.id, now];
    const set = (sql: string, value: unknown) => {
      values.push(value);
      sets.push(`${sql} = ?${values.length}`);
    };
    if (body.data.name !== undefined) set('name', body.data.name);
    if (body.data.enabled !== undefined) set('enabled', body.data.enabled ? 1 : 0);
    if (body.data.webhookUrl !== undefined) {
      const webhook = parseDiscordWebhook(body.data.webhookUrl);
      if (!webhook) return badWebhook(c);
      const config = await encrypt(c, channel.team_id, webhook);
      if (config instanceof Response) return config;
      const failed = await verify(c, deps, webhook);
      if (failed) return failed;
      set('config_encrypted', config);
      set('hint', webhook.hint);
      // A new, working webhook: whatever broke the old one no longer applies.
      set('verified_at', now);
      sets.push('broken_at = NULL', 'broken_reason = NULL');
    }

    const row = await c.env.DB.prepare(
      `UPDATE notification_channels SET ${sets.join(', ')} WHERE id = ?1 RETURNING ${COLUMNS}`,
    )
      .bind(...values)
      .first<ChannelRow>();
    return row ? c.json({ channel: channelDto(row) }) : notFound(c);
  });

  /** Sends the test message again, e.g. after fixing the webhook's channel in Discord. */
  routes.post('/channels/:channelId/test', async (c) => {
    const channel = await loadChannel(c);
    if (!channel) return notFound(c);
    if (!canWrite(channel.role)) return readOnly(c);

    const config = (await decryptConfig(
      c.env.CHANNEL_ENCRYPTION_KEY,
      channel.team_id,
      channel.config_encrypted,
    )) as { url: string };
    const result = await sendDiscordMessage(deps.fetch, config.url, TEST_MESSAGE);
    const now = deps.now();
    if (result.ok) {
      const row = await c.env.DB.prepare(
        `UPDATE notification_channels
         SET verified_at = ?2, broken_at = NULL, broken_reason = NULL, updated_at = ?2
         WHERE id = ?1 RETURNING ${COLUMNS}`,
      )
        .bind(channel.id, now)
        .first<ChannelRow>();
      return c.json({ channel: channelDto(row!) });
    }
    if (result.kind === 'gone') {
      await c.env.DB.prepare(
        `UPDATE notification_channels SET broken_at = ?2, broken_reason = ?3, updated_at = ?2
         WHERE id = ?1`,
      )
        .bind(channel.id, now, `Discord answered ${result.status}: the webhook no longer exists.`)
        .run();
      return webhookGone(c);
    }
    return discordUnavailable(c);
  });

  routes.delete('/channels/:channelId', async (c) => {
    const channel = await loadChannel(c);
    if (!channel) return notFound(c);
    if (!canWrite(channel.role)) return readOnly(c);
    // Its pending deliveries go with it (ON DELETE CASCADE, indexed on channel_id).
    await c.env.DB.prepare(`DELETE FROM notification_channels WHERE id = ?1`)
      .bind(channel.id)
      .run();
    return c.body(null, 204);
  });

  return routes;
}

/** A channel of one of the caller's teams, with their role (teams/access.ts pattern). */
async function loadChannel(c: Context<AppEnv>) {
  const channelId = parseId(c.req.param('channelId'));
  if (channelId === null) return null;
  return c.env.DB.prepare(
    `SELECT ${COLUMNS.split(',')
      .map((column) => `ch.${column.trim()}`)
      .join(', ')}, m.role
     FROM notification_channels AS ch
     JOIN team_members AS m ON m.team_id = ch.team_id AND m.user_id = ?2
     WHERE ch.id = ?1`,
  )
    .bind(channelId, c.var.user.userId)
    .first<ChannelRow & { role: Role }>();
}

/** The stored config, or a 500 that says what is wrong when the key secret is. */
async function encrypt(c: Context<AppEnv>, teamId: number, webhook: DiscordWebhook) {
  try {
    return await encryptConfig(c.env.CHANNEL_ENCRYPTION_KEY, teamId, { url: webhook.url });
  } catch (error) {
    if (!(error instanceof EncryptionKeyError)) throw error;
    console.error({ event: 'channel_key_invalid' });
    return apiError(
      c,
      500,
      'SERVER_MISCONFIGURED',
      "Alerts aren't set up on the server: its CHANNEL_ENCRYPTION_KEY is missing or invalid.",
    );
  }
}

/** Sends the test message (CLAUDE.md §7: "Send a test message on save"). */
async function verify(c: Context, deps: AppDeps, webhook: DiscordWebhook) {
  const result = await sendDiscordMessage(deps.fetch, webhook.url, TEST_MESSAGE);
  if (result.ok) return null;
  return result.kind === 'gone' ? webhookGone(c) : discordUnavailable(c);
}

const WEBHOOK_SHAPE =
  'Paste the webhook URL from Discord (Channel settings, Integrations, Webhooks): https://discord.com/api/webhooks/...';

const badWebhook = (c: Context) =>
  apiError(c, 400, 'VALIDATION_FAILED', 'This is not a Discord webhook URL.', [
    { field: 'webhookUrl', message: WEBHOOK_SHAPE },
  ]);

const webhookGone = (c: Context) =>
  apiError(c, 400, 'WEBHOOK_REJECTED', 'Discord says this webhook does not exist.', [
    { field: 'webhookUrl', message: 'Check that the webhook has not been deleted in Discord.' },
  ]);

const discordUnavailable = (c: Context) =>
  apiError(c, 502, 'DISCORD_UNAVAILABLE', "Couldn't reach Discord. Try again in a moment.");

const limitReached = (c: Context) =>
  apiError(
    c,
    409,
    'LIMIT_REACHED',
    `A team can have at most ${MAX_CHANNELS_PER_TEAM} alert channels.`,
  );
