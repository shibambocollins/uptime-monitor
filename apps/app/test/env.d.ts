import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    // Test-only binding, set in vitest.config.mts.
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
