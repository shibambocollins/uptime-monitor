// Team scoping (every query is scoped to the caller's team). Each lookup
// joins team_members on the caller's user id, so a row from another team comes back as
// "not found" and the route answers 404. Routes never load a row first and check its
// team afterwards, which is easy to forget once.

export type Role = 'OWNER' | 'MEMBER' | 'VIEWER';

/** VIEWER is read-only (the demo account). */
export const canWrite = (role: Role) => role !== 'VIEWER';

export async function teamRole(db: D1Database, userId: number, teamId: number) {
  const row = await db
    .prepare(`SELECT role FROM team_members WHERE team_id = ?1 AND user_id = ?2`)
    .bind(teamId, userId)
    .first<{ role: Role }>();
  return row?.role ?? null;
}

export interface ProjectRow {
  id: number;
  team_id: number;
  name: string;
  created_at: number;
  updated_at: number;
}

/** A live (not soft-deleted) project in one of the caller's teams, with the caller's role. */
export async function findProject(db: D1Database, userId: number, projectId: number) {
  return db
    .prepare(
      `SELECT p.id, p.team_id, p.name, p.created_at, p.updated_at, m.role
       FROM projects AS p JOIN team_members AS m ON m.team_id = p.team_id AND m.user_id = ?2
       WHERE p.id = ?1 AND p.deleted_at IS NULL`,
    )
    .bind(projectId, userId)
    .first<ProjectRow & { role: Role }>();
}

export interface MonitorRow {
  id: number;
  project_id: number;
  name: string;
  url: string;
  interval_seconds: number;
  timeout_ms: number;
  latency_threshold_ms: number;
  expected_status: number;
  enabled: 0 | 1;
  state: 'UP' | 'DEGRADED' | 'DOWN';
  created_at: number;
  updated_at: number;
}

export const MONITOR_COLUMNS = `id, project_id, name, url, interval_seconds, timeout_ms,
  latency_threshold_ms, expected_status, enabled, state, created_at, updated_at`;

/** A monitor in a live project of one of the caller's teams, with the team and role. */
export async function findMonitor(db: D1Database, userId: number, monitorId: number) {
  return db
    .prepare(
      `SELECT ${prefixed('mo', MONITOR_COLUMNS)}, p.team_id, m.role
       FROM monitors AS mo
       JOIN projects AS p ON p.id = mo.project_id AND p.deleted_at IS NULL
       JOIN team_members AS m ON m.team_id = p.team_id AND m.user_id = ?2
       WHERE mo.id = ?1`,
    )
    .bind(monitorId, userId)
    .first<MonitorRow & { team_id: number; role: Role }>();
}

const prefixed = (alias: string, columns: string) =>
  columns
    .split(',')
    .map((column) => `${alias}.${column.trim()}`)
    .join(', ');
