import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Setup files run before each test file. Applying is idempotent: already-applied
// migrations are skipped.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
