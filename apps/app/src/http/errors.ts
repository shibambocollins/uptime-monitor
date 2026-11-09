import type { Context } from 'hono';

/** The one error shape every /api/v1 endpoint returns (CLAUDE.md §12). */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502;

export function apiError(c: Context, status: ErrorStatus, code: string, message: string) {
  return c.json<ApiErrorBody>({ error: { code, message } }, status);
}
