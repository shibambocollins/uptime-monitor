import { sendDiscordMessage } from '../channels/discord';
import { decryptConfig } from '../channels/secrets';
import type { FetchFn } from '../checker/run-checks';
import { alertMessage } from './message';

// Sends queued alerts (alert_deliveries, migrations/0003_alerts.sql) to Discord. Runs once
// per tick in its own invocation (AlertSender), after the checks, so a Discord problem
// can't slow or fail a check (CLAUDE.md §7, delivery isolation).

/** Sent one at a time, so at most this many Discord calls per tick. */
export const DELIVERIES_PER_RUN = 10;
/** After this many failed tries (about 2 hours with the backoff below) a delivery fails. */
export const MAX_ATTEMPTS = 8;
/** A claimed delivery is retried after this long if its run dies before recording it. */
export const LEASE_MS = 5 * 60_000;
/** A send's own timeout (channels/discord.ts) plus a margin: don't start one after this. */
const SEND_BUDGET_MS = 12_000;

export interface DeliverDeps {
  db: D1Database;
  fetch: FetchFn;
  now: () => number;
  encryptionKey: string | undefined;
  /** Stop starting sends that might not finish by this time (the tick deadline). */
  deadline: number;
}

export interface DeliveryStats {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  /** Returned unsent because the deadline was near; not counted as attempts. */
  released: number;
  channelsBroken: number;
  rowsWritten: number;
}

/**
 * Claims up to `limit` due deliveries by moving next_attempt_at a lease ahead (the same
 * lease idea as the monitor claim), so an overlapping run skips them. A RECOVERED alert
 * waits while its incident's DOWN alert to the same channel is still pending, so a channel
 * never hears "back up" before "down".
 */
const CLAIM_SQL = `
UPDATE alert_deliveries
SET attempts = attempts + 1, next_attempt_at = ?1 + ?3
WHERE status = 'PENDING' AND next_attempt_at <= ?1
  AND (event_id, channel_id) IN (
    SELECT d.event_id, d.channel_id
    FROM alert_deliveries AS d
    JOIN alert_events AS e ON e.id = d.event_id
    WHERE d.status = 'PENDING' AND d.next_attempt_at <= ?1
      AND NOT (e.type = 'RECOVERED' AND EXISTS (
        SELECT 1 FROM alert_events AS down
        JOIN alert_deliveries AS dd ON dd.event_id = down.id AND dd.channel_id = d.channel_id
        WHERE down.incident_id = e.incident_id AND down.type = 'DOWN' AND dd.status = 'PENDING'
      ))
    ORDER BY d.next_attempt_at, d.event_id
    LIMIT ?2
  )
RETURNING event_id, channel_id, attempts`;

/** Everything a message needs, for the claimed rows (filtered to exact pairs in code). */
const DETAILS_SQL = `
SELECT d.event_id, d.channel_id, d.attempts, e.type, e.created_at, i.started_at, i.cause,
  mo.name AS monitor_name, mo.url, p.name AS project_name,
  ch.team_id, ch.config_encrypted, ch.enabled, ch.broken_at
FROM alert_deliveries AS d
JOIN alert_events AS e ON e.id = d.event_id
JOIN incidents AS i ON i.id = e.incident_id
JOIN monitors AS mo ON mo.id = e.monitor_id
JOIN projects AS p ON p.id = mo.project_id
JOIN notification_channels AS ch ON ch.id = d.channel_id
WHERE d.event_id IN (SELECT value FROM json_each(?1))
  AND d.channel_id IN (SELECT value FROM json_each(?2))
ORDER BY d.event_id, d.channel_id`;

interface DeliveryRow {
  event_id: number;
  channel_id: number;
  attempts: number;
  type: 'DOWN' | 'RECOVERED';
  created_at: number;
  started_at: number;
  cause: string | null;
  monitor_name: string;
  url: string;
  project_name: string;
  team_id: number;
  config_encrypted: string;
  enabled: 0 | 1;
  broken_at: number | null;
}

const SENT_SQL = `UPDATE alert_deliveries SET status = 'SENT', sent_at = ?3, last_error = NULL
  WHERE event_id = ?1 AND channel_id = ?2`;
const RETRY_SQL = `UPDATE alert_deliveries SET next_attempt_at = ?3, last_error = ?4
  WHERE event_id = ?1 AND channel_id = ?2`;
const FAILED_SQL = `UPDATE alert_deliveries SET status = 'FAILED', last_error = ?3
  WHERE event_id = ?1 AND channel_id = ?2`;
const RELEASE_SQL = `UPDATE alert_deliveries SET attempts = attempts - 1, next_attempt_at = ?3
  WHERE event_id = ?1 AND channel_id = ?2`;
const BROKEN_SQL = `UPDATE notification_channels
  SET broken_at = ?2, broken_reason = ?3, updated_at = ?2 WHERE id = ?1 AND broken_at IS NULL`;

/** 1, 2, 4, ... minutes, at most an hour: retry n waits 2^(n-1) minutes. */
export const backoffMs = (attempts: number) =>
  Math.min(60_000 * 2 ** Math.max(attempts - 1, 0), 60 * 60_000);

export async function deliverDueAlerts(
  deps: DeliverDeps,
  limit = DELIVERIES_PER_RUN,
): Promise<DeliveryStats> {
  const stats: DeliveryStats = {
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    released: 0,
    channelsBroken: 0,
    rowsWritten: 0,
  };
  const claim = await deps.db.prepare(CLAIM_SQL).bind(deps.now(), limit, LEASE_MS).run<{
    event_id: number;
    channel_id: number;
  }>();
  stats.rowsWritten += claim.meta.rows_written;
  if (claim.results.length === 0) return stats;
  stats.claimed = claim.results.length;

  const wanted = new Set(claim.results.map((r) => `${r.event_id}:${r.channel_id}`));
  const { results } = await deps.db
    .prepare(DETAILS_SQL)
    .bind(
      JSON.stringify([...new Set(claim.results.map((r) => r.event_id))]),
      JSON.stringify([...new Set(claim.results.map((r) => r.channel_id))]),
    )
    .all<DeliveryRow>();
  const rows = results.filter((r) => wanted.has(`${r.event_id}:${r.channel_id}`));

  const writes: D1PreparedStatement[] = [];
  const key = (row: DeliveryRow) => [row.event_id, row.channel_id] as const;
  /** Channels found gone during this run: their other deliveries fail without a send. */
  const gone = new Set<number>();

  for (const row of rows) {
    const now = deps.now();
    const fail = (reason: string) => {
      stats.failed++;
      writes.push(deps.db.prepare(FAILED_SQL).bind(...key(row), reason));
    };

    if (row.enabled === 0) {
      fail('channel disabled');
      continue;
    }
    if (row.broken_at !== null || gone.has(row.channel_id)) {
      fail('channel broken');
      continue;
    }
    if (now + SEND_BUDGET_MS > deps.deadline) {
      stats.released++;
      writes.push(deps.db.prepare(RELEASE_SQL).bind(...key(row), now));
      continue;
    }

    let webhookUrl: string;
    try {
      const config = (await decryptConfig(
        deps.encryptionKey,
        row.team_id,
        row.config_encrypted,
      )) as {
        url: string;
      };
      webhookUrl = config.url;
    } catch {
      // A wrong or missing key (a deploy problem): retrying with the same key won't help.
      fail('could not decrypt the channel config');
      continue;
    }

    const content = alertMessage({
      type: row.type,
      monitorName: row.monitor_name,
      projectName: row.project_name,
      url: row.url,
      cause: row.cause,
      startedAt: row.started_at,
      at: row.created_at,
    });
    const result = await sendDiscordMessage(deps.fetch, webhookUrl, content);

    if (result.ok) {
      stats.sent++;
      writes.push(deps.db.prepare(SENT_SQL).bind(...key(row), deps.now()));
    } else if (result.kind === 'gone') {
      gone.add(row.channel_id);
      stats.channelsBroken++;
      const reason = `Discord answered ${result.status}: the webhook no longer exists.`;
      fail(reason);
      writes.push(deps.db.prepare(BROKEN_SQL).bind(row.channel_id, now, reason));
    } else if (row.attempts >= MAX_ATTEMPTS) {
      fail(`gave up after ${row.attempts} attempts`);
    } else {
      stats.retried++;
      // 429: Discord says how long to wait. Otherwise back off exponentially.
      const wait = result.kind === 'rate_limited' ? result.retryAfterMs : backoffMs(row.attempts);
      const error =
        result.kind === 'rate_limited'
          ? 'rate limited by Discord'
          : `Discord unavailable (${result.status ?? 'network'})`;
      writes.push(deps.db.prepare(RETRY_SQL).bind(...key(row), now + wait, error));
    }
  }

  if (writes.length > 0) {
    for (const result of await deps.db.batch(writes)) stats.rowsWritten += result.meta.rows_written;
  }
  return stats;
}
