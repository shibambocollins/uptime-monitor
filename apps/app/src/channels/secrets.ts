import { base64url } from '../auth/crypto';

// Channel configs (a Discord webhook URL is a secret: anyone holding it can post) are
// encrypted at rest with AES-GCM. The key is the Worker secret
// CHANNEL_ENCRYPTION_KEY: 32 random bytes, base64. Stored form: "v1." + base64url(iv ||
// ciphertext). The version prefix leaves room to rotate keys later.
//
// The team id is bound in as additional authenticated data, so a ciphertext copied into
// another team's row fails to decrypt instead of quietly working there.

const VERSION = 'v1.';
const IV_BYTES = 12; // the size AES-GCM is designed for (NIST SP 800-38D)
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Why a saved channel can't be used any more: it was encrypted under a different key (the
 * secret was replaced) or the stored text is damaged. Only adding it again fixes that.
 */
export const UNREADABLE_REASON =
  'Saved under an earlier server encryption key, so it can no longer be read. Delete it and add it again.';

/** Thrown when the key secret is missing or malformed: a deploy problem, not user input. */
export class EncryptionKeyError extends Error {
  constructor() {
    super('CHANNEL_ENCRYPTION_KEY must be 32 random bytes, base64-encoded');
    this.name = 'EncryptionKeyError';
  }
}

const keys = new Map<string, Promise<CryptoKey>>();

function importKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new EncryptionKeyError();
  let cached = keys.get(secret);
  if (!cached) {
    let raw: Uint8Array;
    try {
      raw = Uint8Array.from(atob(secret.trim()), (char) => char.charCodeAt(0));
    } catch {
      throw new EncryptionKeyError();
    }
    if (raw.byteLength !== 32) throw new EncryptionKeyError();
    cached = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keys.set(secret, cached);
  }
  return cached;
}

const aad = (teamId: number) => encoder.encode(`team:${teamId}`);

export async function encryptConfig(
  secret: string | undefined,
  teamId: number,
  config: unknown,
): Promise<string> {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(teamId) },
    key,
    encoder.encode(JSON.stringify(config)),
  );
  const out = new Uint8Array(IV_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), IV_BYTES);
  return VERSION + base64url(out);
}

/** Throws if the value was tampered with, belongs to another team, or the key is wrong. */
export async function decryptConfig(
  secret: string | undefined,
  teamId: number,
  stored: string,
): Promise<unknown> {
  const key = await importKey(secret);
  if (!stored.startsWith(VERSION)) throw new Error('unknown channel config format');
  const bytes = fromBase64url(stored.slice(VERSION.length));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: aad(teamId) },
    key,
    bytes.slice(IV_BYTES),
  );
  return JSON.parse(decoder.decode(plain));
}

function fromBase64url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
