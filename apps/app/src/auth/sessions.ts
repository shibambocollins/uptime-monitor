import { randomToken, sha256Hex } from './crypto';

/**
 * `__Host-`: the browser only accepts it with Secure, Path=/ and no Domain, so no other
 * site (including another *.workers.dev subdomain) can set or overwrite it.
 */
export const SESSION_COOKIE = '__Host-session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** randomToken() output: 43 base64url characters. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export interface SessionUser {
  userId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/** Stores only the token's hash; the token goes to the cookie and nowhere else. */
export async function createSession(
  db: D1Database,
  userId: number,
  now: number,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken();
  const expiresAt = now + SESSION_TTL_MS;
  await db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(await sha256Hex(token), userId, now, expiresAt)
    .run();
  return { token, expiresAt };
}

/**
 * The user behind a session token, or null. An expired session is deleted when it is
 * next presented. Lookup is by hash, so comparing the stored value leaks nothing useful.
 */
export async function findSession(
  db: D1Database,
  token: string,
  now: number,
): Promise<SessionUser | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT s.expires_at, u.id, u.login, u.name, u.avatar_url
       FROM sessions AS s JOIN users AS u ON u.id = s.user_id
       WHERE s.token_hash = ?1`,
    )
    .bind(tokenHash)
    .first<{
      expires_at: number;
      id: number;
      login: string;
      name: string | null;
      avatar_url: string | null;
    }>();
  if (row === null) return null;
  if (row.expires_at <= now) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run();
    return null;
  }
  return { userId: row.id, login: row.login, name: row.name, avatarUrl: row.avatar_url };
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  if (!TOKEN_SHAPE.test(token)) return;
  await db
    .prepare('DELETE FROM sessions WHERE token_hash = ?1')
    .bind(await sha256Hex(token))
    .run();
}
