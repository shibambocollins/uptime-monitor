-- Step 5 of feature work: incidents and the alert outbox.
--
-- These rows are written only when a monitor changes state (opens or closes an incident),
-- never on a steady check, so the 2-rows-per-check budget is unchanged. Every foreign-key
-- column leads an index (test/schema.spec.ts checks it), so cascades don't scan.
--
-- Deferred: alert_rules (per-project and per-monitor overrides). For now every enabled,
-- working channel of the team gets the team's DOWN and RECOVERED alerts.

-- One per outage: opened when a monitor goes DOWN, resolved when it is UP again.
CREATE TABLE incidents (
  id INTEGER PRIMARY KEY,
  monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  -- What the check that opened it saw (e.g. "unexpected status 503"). Never a body.
  cause TEXT
);
-- A monitor's incidents, newest first, for the API.
CREATE INDEX incidents_monitor_id ON incidents (monitor_id, started_at);
-- At most one open incident per monitor. Partial, so only open incidents have an entry.
CREATE UNIQUE INDEX incidents_open ON incidents (monitor_id) WHERE resolved_at IS NULL;

-- A team's alert destinations. config holds the secret part (a Discord webhook URL)
-- encrypted with AES-GCM; hint is the few characters the UI may show.
CREATE TABLE notification_channels (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('DISCORD', 'EMAIL')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  config_encrypted TEXT NOT NULL,
  hint TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- Set when delivery shows the destination is gone (Discord 404); cleared on re-save.
  broken_at INTEGER,
  broken_reason TEXT,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX notification_channels_team_id ON notification_channels (team_id);

-- The outbox: what happened. Written in the same batch as the check that caused it, so
-- an alert is never lost and a slow or failing channel never blocks a check.
CREATE TABLE alert_events (
  id INTEGER PRIMARY KEY,
  monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  incident_id INTEGER NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('DOWN', 'RECOVERED')),
  created_at INTEGER NOT NULL
);
CREATE INDEX alert_events_monitor_id ON alert_events (monitor_id, created_at);
-- One DOWN and one RECOVERED per incident, however often a batch is retried.
CREATE UNIQUE INDEX alert_events_incident_type ON alert_events (incident_id, type);

-- One row per event and channel: the delivery queue. A channel failing only delays its
-- own rows (delivery isolation).
CREATE TABLE alert_deliveries (
  event_id INTEGER NOT NULL REFERENCES alert_events (id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES notification_channels (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  sent_at INTEGER,
  PRIMARY KEY (event_id, channel_id)
) WITHOUT ROWID;
CREATE INDEX alert_deliveries_channel_id ON alert_deliveries (channel_id);
-- The tick's "what is due?" query. Partial, so sent and failed rows (history) are not in
-- it: the scan stays as small as the queue, not the whole table.
CREATE INDEX alert_deliveries_due ON alert_deliveries (next_attempt_at) WHERE status = 'PENDING';
