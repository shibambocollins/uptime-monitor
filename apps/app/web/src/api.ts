// A thin client for /api/v1. Same origin as the page, so the session cookie goes along and
// there is no CORS. Errors come back in one shape: {error: {code, message,
// details?}} (src/http/errors.ts).

export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: FieldError[] = [],
  ) {
    super(message);
  }

  /** The message plus any field errors, for showing under a form. */
  get text() {
    return [this.message, ...this.details.map((d) => d.message)].join(' ');
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    // JSON only: the API refuses other content types on writes (a CSRF defence).
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => null)) as {
    error?: { code: string; message: string; details?: FieldError[] };
  } | null;
  if (!response.ok) {
    const error = data?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? `The server answered ${response.status}.`,
      error?.details,
    );
  }
  return data as T;
}

// --- Response shapes (the DTOs in src/*/routes.ts) ---

export type Role = 'OWNER' | 'MEMBER' | 'VIEWER';
export type MonitorState = 'UP' | 'DEGRADED' | 'DOWN';

export interface Me {
  user: { id: number; login: string; name: string | null; avatarUrl: string | null };
  teams: { id: number; name: string; role: Role }[];
  /** Signed in as the shared read-only demo user. */
  demo: boolean;
}

export interface Project {
  id: number;
  teamId: number;
  name: string;
}

export interface Monitor {
  id: number;
  projectId: number;
  name: string;
  url: string;
  intervalSeconds: number;
  enabled: boolean;
  state: MonitorState;
}

export interface Channel {
  id: number;
  name: string;
  hint: string;
  enabled: boolean;
  brokenAt: number | null;
  brokenReason: string | null;
}

export interface MonitorStatus {
  monitorId: number;
  lastCheckedAt: number | null;
  checks24h: number;
  uptime24h: number | null;
  avgLatencyMs24h: number | null;
  downSince: number | null;
}

export interface Incident {
  id: number;
  monitorId: number;
  monitorName: string;
  startedAt: number;
  resolvedAt: number | null;
  cause: string | null;
}

export interface TeamStatus {
  monitors: MonitorStatus[];
  incidents: Incident[];
}
