import type { Context } from 'hono';
import type { z } from 'zod';
import { apiError, type FieldError } from './errors';

/** Bodies here are a few hundred bytes; 16 KB leaves room and stops a client sending megabytes. */
export const MAX_BODY_BYTES = 16 * 1024;

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/**
 * Reads a JSON body and validates it with a Zod schema. Requires Content-Type
 * application/json: an HTML form can't send that type cross-site without a CORS preflight,
 * which this API never answers, so it adds a CSRF defence on top of the SameSite=Lax cookie.
 */
export async function parseJsonBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<Parsed<z.output<S>>> {
  const type = c.req.header('Content-Type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    return fail(apiError(c, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the body as application/json.'));
  }
  const declared = Number(c.req.header('Content-Length') ?? 0);
  if (declared > MAX_BODY_BYTES) return fail(tooLarge(c));

  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return fail(tooLarge(c));

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail(apiError(c, 400, 'INVALID_JSON', 'The body is not valid JSON.'));
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    const details: FieldError[] = result.error.issues.map((issue) => ({
      field: issue.path.map(String).join('.'),
      message: issue.message,
    }));
    return fail(apiError(c, 400, 'VALIDATION_FAILED', 'Some fields are invalid.', details));
  }
  return { ok: true, data: result.data };
}

/**
 * A path id: a positive integer without leading zeros or signs. Anything else can't name a
 * row, so callers answer 404, the same as for an id that doesn't exist.
 */
export function parseId(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

const fail = (response: Response) => ({ ok: false as const, response });

const tooLarge = (c: Context) =>
  apiError(c, 413, 'PAYLOAD_TOO_LARGE', `Bodies can be at most ${MAX_BODY_BYTES} bytes.`);
