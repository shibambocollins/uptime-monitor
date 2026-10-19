import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/coverage/',
    '**/.wrangler/',
    '**/worker-configuration.d.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
);
