// The read-only demo (CLAUDE.md §8): "try the demo" signs a visitor in as one shared demo
// user, a VIEWER of the team named by DEMO_TEAM_ID, so recruiters can look around without
// authorizing GitHub. VIEWER can't write (teams/access.ts canWrite), so the demo sees real
// monitors, uptime and incidents but can't change them.

/** GitHub user ids start at 1, so 0 can never be a real GitHub account. */
export const DEMO_GITHUB_ID = 0;
/** Shorter than a real session: a demo visit is short, and the row is cleaned up sooner. */
export const DEMO_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Finds or creates the demo user, makes sure it is a VIEWER of `teamId` and of nothing else,
 * and returns its id. Null when the team doesn't exist (demo not set up).
 *
 * After the first call this writes no rows: every statement is a no-op when the rows are
 * already right (ON CONFLICT DO NOTHING, and the DELETEs match nothing).
 */
export async function demoUser(db: D1Database, teamId: number, now: number) {
  const team = await db.prepare(`SELECT id FROM teams WHERE id = ?1`).bind(teamId).first();
  if (!team) return null;

  const results = await db.batch<{ id: number }>([
    db
      .prepare(
        `INSERT INTO users (github_id, login, name, avatar_url, created_at, updated_at)
         VALUES (?1, 'demo', 'Demo visitor', NULL, ?2, ?2)
         ON CONFLICT (github_id) DO NOTHING`,
      )
      .bind(DEMO_GITHUB_ID, now),
    // Never more than VIEWER, and only in the demo team: if DEMO_TEAM_ID changes, or a row
    // was changed by hand, the demo loses whatever else it had.
    db
      .prepare(
        `DELETE FROM team_members
         WHERE user_id = (SELECT id FROM users WHERE github_id = ?1)
           AND (team_id != ?2 OR role != 'VIEWER')`,
      )
      .bind(DEMO_GITHUB_ID, teamId),
    db
      .prepare(
        `INSERT INTO team_members (team_id, user_id, role, created_at)
         SELECT ?2, id, 'VIEWER', ?3 FROM users WHERE github_id = ?1
         ON CONFLICT DO NOTHING`,
      )
      .bind(DEMO_GITHUB_ID, teamId, now),
    db.prepare(`SELECT id FROM users WHERE github_id = ?1`).bind(DEMO_GITHUB_ID),
  ]);
  return results[3]!.results[0]!.id;
}
