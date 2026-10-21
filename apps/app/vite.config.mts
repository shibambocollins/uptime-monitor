import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The React app lives in web/ and builds into the folder the Worker serves as static assets
// (wrangler.jsonc "assets"). Dev: run `wrangler dev` (port 8787) and `vite` side by side;
// the proxy keeps /api on the page's own origin, as in production.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
