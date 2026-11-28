import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps, AppEnv } from '../app-env';
import { apiError, notFound, readOnly } from '../http/errors';
import { parseId, parseJsonBody } from '../http/validate';
import { canWrite, findProject, type ProjectRow, teamRole } from '../teams/access';

/** Live projects per team. Each one is a row read in every list; a cap keeps that bounded. */
export const MAX_PROJECTS_PER_TEAM = 20;

const name = z.string().trim().min(1).max(100);
const CreateProject = z.strictObject({ name });
const UpdateProject = z.strictObject({ name });

/** The project DTO: never the row itself. */
export const projectDto = (row: ProjectRow) => ({
  id: row.id,
  teamId: row.team_id,
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Mounted at /api/v1 behind requireSession (app.ts). */
export function projectRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>();

  routes.get('/teams/:teamId/projects', async (c) => {
    const teamId = parseId(c.req.param('teamId'));
    if (teamId === null || (await teamRole(c.env.DB, c.var.user.userId, teamId)) === null) {
      return notFound(c);
    }
    const { results } = await c.env.DB.prepare(
      `SELECT id, team_id, name, created_at, updated_at FROM projects
       WHERE team_id = ?1 AND deleted_at IS NULL ORDER BY id`,
    )
      .bind(teamId)
      .all<ProjectRow>();
    return c.json({ projects: results.map(projectDto) });
  });

  routes.post('/teams/:teamId/projects', async (c) => {
    const teamId = parseId(c.req.param('teamId'));
    const role = teamId === null ? null : await teamRole(c.env.DB, c.var.user.userId, teamId);
    if (teamId === null || role === null) return notFound(c);
    if (!canWrite(role)) return readOnly(c);

    const body = await parseJsonBody(c, CreateProject);
    if (!body.ok) return body.response;

    // The cap is checked in the INSERT itself, so two requests at once can't both squeeze
    // past it (D1 runs one statement at a time). 2 rows written: the row and its index.
    const now = deps.now();
    const row = await c.env.DB.prepare(
      `INSERT INTO projects (team_id, name, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?3
       WHERE (SELECT count(*) FROM projects WHERE team_id = ?1 AND deleted_at IS NULL) < ?4
       RETURNING id, team_id, name, created_at, updated_at`,
    )
      .bind(teamId, body.data.name, now, MAX_PROJECTS_PER_TEAM)
      .first<ProjectRow>();
    if (row === null) {
      return apiError(
        c,
        409,
        'LIMIT_REACHED',
        `A team can have at most ${MAX_PROJECTS_PER_TEAM} projects.`,
      );
    }
    return c.json({ project: projectDto(row) }, 201);
  });

  routes.get('/projects/:projectId', async (c) => {
    const project = await loadProject(c);
    return project ? c.json({ project: projectDto(project) }) : notFound(c);
  });

  routes.patch('/projects/:projectId', async (c) => {
    const project = await loadProject(c);
    if (!project) return notFound(c);
    if (!canWrite(project.role)) return readOnly(c);

    const body = await parseJsonBody(c, UpdateProject);
    if (!body.ok) return body.response;

    const row = await c.env.DB.prepare(
      `UPDATE projects SET name = ?2, updated_at = ?3
       WHERE id = ?1 AND deleted_at IS NULL
       RETURNING id, team_id, name, created_at, updated_at`,
    )
      .bind(project.id, body.data.name, deps.now())
      .first<ProjectRow>();
    return row ? c.json({ project: projectDto(row) }) : notFound(c);
  });

  /**
   * Soft delete: the project is hidden and its monitors are disabled in the
   * same batch, so the checker stops at once and the claim stays a single-table scan.
   * Rows are purged later. OWNER only: it switches off every monitor in the project.
   */
  routes.delete('/projects/:projectId', async (c) => {
    const project = await loadProject(c);
    if (!project) return notFound(c);
    if (project.role !== 'OWNER') {
      return apiError(c, 403, 'FORBIDDEN', 'Only a team owner can delete a project.');
    }
    const now = deps.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE projects SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL`,
      ).bind(project.id, now),
      c.env.DB.prepare(
        `UPDATE monitors SET enabled = 0, updated_at = ?2 WHERE project_id = ?1 AND enabled = 1`,
      ).bind(project.id, now),
    ]);
    return c.body(null, 204);
  });

  return routes;
}

async function loadProject(c: Context<AppEnv>) {
  const projectId = parseId(c.req.param('projectId'));
  return projectId === null ? null : findProject(c.env.DB, c.var.user.userId, projectId);
}
