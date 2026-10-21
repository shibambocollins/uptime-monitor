-- Phase 0 step 4: the subset of the schema the checker needs (CLAUDE.md §10).
-- Every index costs at least one extra row written when its columns change (CLAUDE.md §5),
-- so the only indexes here are primary keys.

-- No index on next_run_at: the claim rewrites it on every check. The claim scans this
-- table instead, which costs reads, not writes.
-- There is no lease_until column: the claim moves next_run_at into the future, and that
-- is the lease (a later tick no longer sees the monitor as due).
CREATE TABLE monitors (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK (interval_seconds >= 60),
  timeout_ms INTEGER NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 30000),
  latency_threshold_ms INTEGER NOT NULL DEFAULT 2000 CHECK (latency_threshold_ms > 0),
  expected_status INTEGER NOT NULL DEFAULT 200 CHECK (expected_status BETWEEN 100 AND 599),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'UP' CHECK (state IN ('UP', 'DEGRADED', 'DOWN')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_slow INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  -- Epoch ms (UTC). 0 means "due now".
  next_run_at INTEGER NOT NULL DEFAULT 0
);

-- WITHOUT ROWID: the primary key is the table, so an upsert into an existing hour
-- writes one row and there is no separate index to keep in sync.
-- Latency buckets count only checks that got a response; failures without one
-- (timeout, connection error) are counted in failures only.
CREATE TABLE check_rollups_hourly (
  monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  -- Start of the hour, epoch ms (UTC).
  hour INTEGER NOT NULL,
  total INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  latency_sum_ms INTEGER NOT NULL,
  lt_250 INTEGER NOT NULL,
  lt_500 INTEGER NOT NULL,
  lt_1000 INTEGER NOT NULL,
  lt_2500 INTEGER NOT NULL,
  lt_5000 INTEGER NOT NULL,
  ge_5000 INTEGER NOT NULL,
  PRIMARY KEY (monitor_id, hour)
) WITHOUT ROWID;

-- Raw checks are stored only for failures and state changes. No secondary index yet:
-- add one when the API reads this table (inserts here are rare, so it would be cheap).
CREATE TABLE check_events (
  id INTEGER PRIMARY KEY,
  monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  status_code INTEGER,
  response_ms INTEGER,
  error TEXT,
  -- State after this check.
  state TEXT NOT NULL CHECK (state IN ('UP', 'DEGRADED', 'DOWN'))
);

-- One row per UTC day, upserted once per tick (CLAUDE.md §5 daily-cap safety).
CREATE TABLE usage_daily (
  -- 'YYYY-MM-DD' (UTC).
  day TEXT NOT NULL PRIMARY KEY,
  ticks INTEGER NOT NULL,
  checks INTEGER NOT NULL,
  -- As reported by D1 for the checker's own statements, excluding this upsert.
  rows_written INTEGER NOT NULL,
  rows_read INTEGER NOT NULL
) WITHOUT ROWID;
