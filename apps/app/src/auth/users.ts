import type { GithubProfile } from './github';

/**
 * Finds or creates the user for a GitHub profile and returns their id. A first login also
 * creates a personal team with the user as OWNER, so they have somewhere to add monitors.
 *
 * Keyed by GitHub's numeric id only; never matched by email (CLAUDE.md §8). The profile
 * fields are refreshed on every login (one row written; logins are rare).
 */
export async function upsertGithubUser(
  db: D1Database,
  profile: GithubProfile,
  now: number,
): Promise<{ userId: number; created: boolean }> {
  const existing = await updateProfile(db, profile, now);
  if (existing !== null) return { userId: existing, created: false };

  try {
    // One batch, so a user never exists without their team. D1 runs a batch as one
    // transaction on one connection, so last_insert_rowid() is the team just inserted.
    const [user] = await db.batch<{ id: number }>([
      db
        .prepare(
          `INSERT INTO users (github_id, login, name, avatar_url, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5) RETURNING id`,
        )
        .bind(profile.id, profile.login, profile.name, profile.avatarUrl, now),
      db
        .prepare(`INSERT INTO teams (name, created_at) VALUES (?1, ?2)`)
        .bind(teamName(profile), now),
      db
        .prepare(
          `INSERT INTO team_members (team_id, user_id, role, created_at)
           VALUES (last_insert_rowid(), (SELECT id FROM users WHERE github_id = ?1), 'OWNER', ?2)`,
        )
        .bind(profile.id, now),
    ]);
    return { userId: user!.results[0]!.id, created: true };
  } catch (error) {
    // Two callbacks for the same new user at once: the other one created the account.
    if (String(error).includes('UNIQUE constraint failed: users.github_id')) {
      const raced = await updateProfile(db, profile, now);
      if (raced !== null) return { userId: raced, created: false };
    }
    throw error;
  }
}

async function updateProfile(db: D1Database, profile: GithubProfile, now: number) {
  const row = await db
    .prepare(
      `UPDATE users SET login = ?2, name = ?3, avatar_url = ?4, updated_at = ?5
       WHERE github_id = ?1 RETURNING id`,
    )
    .bind(profile.id, profile.login, profile.name, profile.avatarUrl, now)
    .first<{ id: number }>();
  return row?.id ?? null;
}

/** GitHub logins are at most 39 characters, so this fits teams.name (1-100). */
const teamName = (profile: GithubProfile) => `${profile.login}'s team`;
