import { env } from 'cloudflare:workers';

/** Empties every table. Children first, so no cascade does the work (and hides a bug). */
export async function resetDb(): Promise<void> {
  const tables = [
    'check_events',
    'check_rollups_hourly',
    'monitors',
    'projects',
    'team_members',
    'sessions',
    'teams',
    'users',
    'usage_daily',
  ];
  await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}

/** A team with one project, for tests that only need somewhere to put monitors. */
export async function addProject(now = 0): Promise<number> {
  const team = await env.DB.prepare(
    `INSERT INTO teams (name, created_at) VALUES ('Test team', ?1) RETURNING id`,
  )
    .bind(now)
    .first<{ id: number }>();
  const project = await env.DB.prepare(
    `INSERT INTO projects (team_id, name, created_at, updated_at)
     VALUES (?1, 'Test project', ?2, ?2) RETURNING id`,
  )
    .bind(team!.id, now)
    .first<{ id: number }>();
  return project!.id;
}
