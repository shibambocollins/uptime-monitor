import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Runs tests inside workerd (the Workers runtime), using this Worker's wrangler config.
export default defineConfig(async () => {
  // Read in Node, then handed to the tests as a binding: test/apply-migrations.ts applies
  // them to the local D1 database, so tests run against the real schema.
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
