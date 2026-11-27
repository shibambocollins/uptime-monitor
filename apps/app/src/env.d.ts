// Secrets are not in wrangler.jsonc, so `wrangler types` only sees them when a local
// .dev.vars exists (and never in CI). Declared here so the code always typechecks.
// Set locally in apps/app/.dev.vars (see .dev.vars.example), in production with
// `npx wrangler secret put <NAME>`, and in tests in vitest.config.mts.
interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** 32 random bytes, base64: AES-GCM key for alert channel configs (channels/secrets.ts). */
  CHANNEL_ENCRYPTION_KEY: string;
  /** The team the read-only demo shows (auth/demo.ts). Unset: no demo. */
  DEMO_TEAM_ID?: string;
  /** Healthchecks.io ping URL for the dead man's switch (checker/heartbeat.ts). Optional. */
  HEALTHCHECK_PING_URL?: string;
}

declare namespace Cloudflare {
  interface Env {
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    CHANNEL_ENCRYPTION_KEY: string;
    DEMO_TEAM_ID?: string;
    HEALTHCHECK_PING_URL?: string;
  }
}
