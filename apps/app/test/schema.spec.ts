import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimDueMonitors } from '../src/checker/claim';
import { checkGroup } from '../src/checker/group';
import { addProject, resetDb } from './fixtures';

const T0 = Date.UTC(2026, 10, 9, 8, 0, 0);

beforeEach(resetDb);

const run = (sql: string, ...params: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...params)
    .run();

async function addMonitor(projectId: number): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO monitors (project_id, name, url, interval_seconds, next_run_at, created_at, updated_at)
     VALUES (?1, 'm', 'https://target.example/', 60, ?2, ?2, ?2) RETURNING id`,
  )
    .bind(projectId, T0)
    .first<{ id: number }>();
  return row!.id;
}

async function addUser(githubId: number): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO users (github_id, login, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3) RETURNING id`,
  )
    .bind(githubId, `user${githubId}`, T0)
    .first<{ id: number }>();
  return row!.id;
}

// D1 refuses the table-valued pragma_*() functions (SQLITE_AUTH), so these use one
// PRAGMA statement per table. Names come from the schema itself, not from input.
const pragma = async <T>(call: string) => (await env.DB.prepare(`PRAGMA ${call}`).all<T>()).results;

async function appTables(): Promise<string[]> {
  const tables = await pragma<{ name: string; type: string }>('table_list');
  return tables
    .filter((t) => t.type === 'table' && !/^(sqlite_|_cf_|d1_)/.test(t.name))
    .map((t) => t.name);
}

/** Columns that lead an index on `table`, including a WITHOUT ROWID primary key. */
async function leadingIndexColumns(table: string): Promise<Set<string>> {
  const leading = new Set<string>();
  for (const { name } of await pragma<{ name: string }>(`index_list(${table})`)) {
    const [first] = await pragma<{ name: string }>(`index_info(${name})`);
    if (first) leading.add(first.name);
  }
  return leading;
}

const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

describe('indexes', () => {
  // Without an index on the child column, deleting a parent scans the whole child table
  // once per deleted row (4.0M rows read on 2026-11-09, docs/phase-0-checklist.md §7).
  it('gives every foreign-key column an index or primary key that starts with it', async () => {
    const tables = await appTables();
    const missing: string[] = [];
    let foreignKeyCount = 0;
    for (const table of tables) {
      const foreignKeys = await pragma<{ from: string }>(`foreign_key_list(${table})`);
      foreignKeyCount += foreignKeys.length;
      const leading = await leadingIndexColumns(table);
      for (const { from } of foreignKeys) {
        if (!leading.has(from)) missing.push(`${table}.${from}`);
      }
    }
    expect(foreignKeyCount).toBeGreaterThanOrEqual(7);
    expect(missing).toEqual([]);
  });

  it('has no index on monitors.next_run_at (the claim rewrites it every check)', async () => {
    const columns = new Set<string>();
    for (const { name } of await pragma<{ name: string }>('index_list(monitors)')) {
      for (const { name: column } of await pragma<{ name: string }>(`index_info(${name})`)) {
        columns.add(column);
      }
    }
    expect([...columns]).toEqual(['project_id']);
  });
});

describe('write cost per check with the project_id index (CLAUDE.md §5: ≤ 2 rows)', () => {
  it('counts the index row when a monitor is inserted, so the measurement sees indexes', async () => {
    const projectId = await addProject(T0);
    const result = await run(
      `INSERT INTO monitors (project_id, name, url, created_at, updated_at)
       VALUES (?1, 'm', 'https://target.example/', ?2, ?2)`,
      projectId,
      T0,
    );
    expect(result.meta.rows_written).toBe(2);
  });

  it('writes 1 row to claim a monitor and 1 to update its state', async () => {
    const id = await addMonitor(await addProject(T0));

    const claim = await claimDueMonitors(env.DB, T0, 40);
    expect(claim.monitors.map((m) => m.id)).toEqual([id]);
    expect(claim.meta.rows_written).toBe(1);

    // A failure changes the counters, so the monitor row is rewritten too.
    const group = await checkGroup(claim.monitors, {
      db: env.DB,
      fetch: async () => new Response(null, { status: 500 }),
      now: () => T0,
    });
    expect(group.rowsWritten.rollup).toBe(1);
    expect(group.rowsWritten.monitor).toBe(1);
    // The event row plus its check_events_monitor_id entry. Failures and state changes
    // only, so this does not apply to a healthy check.
    expect(group.rowsWritten.event).toBe(2);
  });
});

describe('cascades', () => {
  it('deleting a team removes its projects, monitors, rollups, events and memberships', async () => {
    const projectId = await addProject(T0);
    const monitorId = await addMonitor(projectId);
    const userId = await addUser(1);
    await run(
      `INSERT INTO team_members (team_id, user_id, role, created_at)
       SELECT team_id, ?1, 'OWNER', ?2 FROM projects WHERE id = ?3`,
      userId,
      T0,
      projectId,
    );
    const { monitors } = await claimDueMonitors(env.DB, T0, 40);
    await checkGroup(monitors, {
      db: env.DB,
      fetch: async () => new Response(null, { status: 500 }),
      now: () => T0,
    });
    expect(monitors.map((m) => m.id)).toEqual([monitorId]);
    expect(await count('check_events')).toBe(1);
    expect(await count('check_rollups_hourly')).toBe(1);

    await run('DELETE FROM teams');

    for (const table of [
      'projects',
      'monitors',
      'check_rollups_hourly',
      'check_events',
      'team_members',
    ]) {
      expect({ table, rows: await count(table) }).toEqual({ table, rows: 0 });
    }
    expect(await count('users')).toBe(1);
  });

  it('deleting a user removes their sessions and memberships, not the team', async () => {
    const projectId = await addProject(T0);
    const userId = await addUser(1);
    await run(
      `INSERT INTO team_members (team_id, user_id, role, created_at)
       SELECT team_id, ?1, 'OWNER', ?2 FROM projects WHERE id = ?3`,
      userId,
      T0,
      projectId,
    );
    await run(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?3)`,
      'a'.repeat(64),
      userId,
      T0,
    );

    await run('DELETE FROM users WHERE id = ?1', userId);

    expect(await count('sessions')).toBe(0);
    expect(await count('team_members')).toBe(0);
    expect(await count('teams')).toBe(1);
    expect(await count('projects')).toBe(1);
  });
});

describe('constraints', () => {
  it('allows one account per GitHub user id', async () => {
    await addUser(42);
    await expect(addUser(42)).rejects.toThrow(/UNIQUE constraint failed: users.github_id/);
  });

  it('rejects a monitor without a project, or with one that does not exist', async () => {
    await expect(
      run(
        `INSERT INTO monitors (name, url, created_at, updated_at) VALUES ('m', 'https://a.example/', 0, 0)`,
      ),
    ).rejects.toThrow(/NOT NULL constraint failed: monitors.project_id/);
    await expect(addMonitor(999)).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('rejects an unknown role and a session hash that is not 64 hex characters long', async () => {
    const projectId = await addProject(T0);
    const userId = await addUser(1);
    await expect(
      run(
        `INSERT INTO team_members (team_id, user_id, role, created_at)
         SELECT team_id, ?1, 'ADMIN', 0 FROM projects WHERE id = ?2`,
        userId,
        projectId,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      run(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('short', ?1, 0, 0)`,
        userId,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
