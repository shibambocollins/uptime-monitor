import type { Context } from 'hono';

/** One problem with one input field: `field` is a dotted path, or '' for the whole body. */
export interface FieldError {
  field: string;
  message: string;
}

/** The one error shape every /api/v1 endpoint returns. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: FieldError[] };
}

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 502;

export function apiError(
  c: Context,
  status: ErrorStatus,
  code: string,
  message: string,
  details?: FieldError[],
) {
  return c.json<ApiErrorBody>(
    { error: details ? { code, message, details } : { code, message } },
    status,
  );
}

/**
 * The 404 for a resource that doesn't exist *or belongs to a team the caller isn't in*.
 * Both give the same answer, so nobody can probe ids to learn what other teams have.
 */
export const notFound = (c: Context) => apiError(c, 404, 'NOT_FOUND', 'Not found.');

/** A write by a VIEWER. They can see the resource, so 403 reveals nothing new. */
export const readOnly = (c: Context) =>
  apiError(c, 403, 'FORBIDDEN', 'Your role in this team is read-only.');
