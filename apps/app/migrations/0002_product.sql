-- Step 2 of feature work: the tables auth and the monitor API need (CLAUDE.md §10).
--
-- Index rules (CLAUDE.md §5, and docs/phase-0-checklist.md §7):
-- * Every index costs a row written whenever a write changes its columns, so index only
--   columns that rarely change. Still no index on monitors.next_run_at.
-- * Every foreign-key column gets an index (or leads a primary key). Without one, deleting
--   a parent makes SQLite scan the whole child table for each deleted row: on 2026-11-09 a
--   cascade from 60 monitors read 4.0M rows, 80% of a day's read cap.
--   test/schema.spec.ts checks this for every table.
--
-- Timestamps are epoch milliseconds (UTC), set by the app (no SQL defaults).

-- D1 runs a migration in a transaction and always enforces foreign keys, so the monitors
-- rebuild below defers the checks to the end of the transaction instead (D1 docs,
-- "Define foreign keys"). The tables involved are empty in remote D1 (seeded data deleted
-- 2026-11-09).
PRAGMA defer_foreign_keys = on;

-- GitHub's numeric id is the identity (CLAUDE.md §8): logins and emails can change.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  -- A verified address from GitHub, only if the user turns on email alerts. Personal
  -- data: minimal and deletable (POPIA).
  email TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Only the SHA-256 hash of the cookie token is stored (hex), so a database leak does not
-- leak sessions. Fixed expiry, no "last seen" column: updating one on every request would
-- cost a row written per request.
CREATE TABLE sessions (
  token_hash TEXT NOT NULL PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX sessions_user_id ON sessions (user_id);

CREATE TABLE teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at INTEGER NOT NULL
);

-- VIEWER is for the read-only demo (CLAUDE.md §8). SQLite cannot change a CHECK without
-- rebuilding the table, so the planned roles are all here from the start.
CREATE TABLE team_members (
  team_id INTEGER NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'MEMBER', 'VIEWER')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
) WITHOUT ROWID;
-- "Which teams am I in?" on every request, and the cascade when a user is deleted.
CREATE INDEX team_members_user_id ON team_members (user_id);

-- Soft delete (CLAUDE.md §10): deleted_at set, purged later. Soft-deleting a project must
-- also disable its monitors, so the claim stays a single-table scan.
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX projects_team_id ON projects (team_id);

-- monitors gains project_id NOT NULL. SQLite cannot add a NOT NULL foreign key to an
-- existing table, so the table is rebuilt. check_events is rebuilt too, to add its index.
-- Dropping monitors cascades to check_rollups_hourly (kept: its definition is unchanged).
DROP TABLE check_events;
DROP TABLE monitors;

-- Changes from 0001: project_id, name, created_at, updated_at, and a length cap on url
-- (MAX_URL_LENGTH in @uptime/core). Deliberately no last_checked_at (CLAUDE.md §10
-- listed it): writing it on every check would rewrite this row every check, one more row
-- per check. The last check time is next_run_at minus the interval, because the claim
-- sets next_run_at to the tick time plus the interval.
CREATE TABLE monitors (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  url TEXT NOT NULL CHECK (length(url) <= 2048),
  interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK (interval_seconds >= 60),
  timeout_ms INTEGER NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 30000),
  latency_threshold_ms INTEGER NOT NULL DEFAULT 2000 CHECK (latency_threshold_ms > 0),
  expected_status INTEGER NOT NULL DEFAULT 200 CHECK (expected_status BETWEEN 100 AND 599),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'UP' CHECK (state IN ('UP', 'DEGRADED', 'DOWN')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_slow INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  -- Epoch ms (UTC). 0 means "due now". Not indexed: the claim rewrites it every check.
  next_run_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- project_id only changes if a monitor is moved, so the claim and the result writes,
-- which touch other columns, don't write to this index (test/schema.spec.ts measures it).
CREATE INDEX monitors_project_id ON monitors (project_id);

-- Same columns as 0001. Rows are inserted only for failures and state changes, so the
-- index costs few writes; the API lists a monitor's events newest first with it.
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
CREATE INDEX check_events_monitor_id ON check_events (monitor_id, checked_at);
