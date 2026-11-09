// Web Crypto helpers for sessions and OAuth (CLAUDE.md §8). No passwords anywhere: a
// SHA-256 of a 32-byte random token is enough, because the token itself is unguessable.

const encoder = new TextEncoder();

/** 32 random bytes as base64url (43 characters): session tokens, OAuth state, PKCE verifier. */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

/** What sessions.token_hash stores: 64 lower-case hex characters. */
export async function sha256Hex(text: string): Promise<string> {
  return [...(await sha256(text))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** PKCE S256 (RFC 7636 §4.2): base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await sha256(verifier));
}

/**
 * Compares two secrets without leaking where they differ. Lengths may leak, which is
 * fine here: every token we compare has a fixed, public length.
 * crypto.subtle.timingSafeEqual is a Workers extension, not standard Web Crypto.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}
