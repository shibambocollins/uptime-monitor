// The text of a Discord alert. Pure, so it is easy to test and to reuse for email later.

export interface AlertFacts {
  type: 'DOWN' | 'RECOVERED';
  monitorName: string;
  projectName: string;
  url: string;
  cause: string | null;
  startedAt: number;
  /** The time of the event: when it went down, or when it recovered. */
  at: number;
}

/** Discord's limit for a message's content. */
export const MAX_CONTENT_LENGTH = 2000;

export function alertMessage(facts: AlertFacts): string {
  const where = `${facts.projectName} · ${displayUrl(facts.url)}`;
  const lines =
    facts.type === 'DOWN'
      ? [
          `🔴 **${facts.monitorName}** is DOWN`,
          where,
          `Cause: ${facts.cause ?? 'unknown'}`,
          `Since ${utc(facts.startedAt)}`,
        ]
      : [
          `🟢 **${facts.monitorName}** is back UP after ${duration(facts.at - facts.startedAt)}`,
          where,
          `Down from ${utc(facts.startedAt)} to ${utc(facts.at)}`,
        ];
  const text = lines.join('\n');
  return text.length <= MAX_CONTENT_LENGTH ? text : `${text.slice(0, MAX_CONTENT_LENGTH - 1)}…`;
}

/** Scheme, host and path only: a query string can carry tokens (CLAUDE.md §8). */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url;
  }
}

/** "2026-11-27 15:04 UTC" */
const utc = (time: number) => `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** "45 s", "3 min", "2 h 5 min", "1 d 3 h". */
export function duration(ms: number): string {
  const s = Math.max(Math.round(ms / 1000), 0);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}
