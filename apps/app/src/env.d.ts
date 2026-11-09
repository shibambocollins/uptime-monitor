// Secrets are not in wrangler.jsonc, so `wrangler types` only sees them when a local
// .dev.vars exists (and never in CI). Declared here so the code always typechecks.
// Set locally in apps/app/.dev.vars (see .dev.vars.example), in production with
// `npx wrangler secret put <NAME>`, and in tests in vitest.config.mts.
interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

declare namespace Cloudflare {
  interface Env {
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
  }
}
