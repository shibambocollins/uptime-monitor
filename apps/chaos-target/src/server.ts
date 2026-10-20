import { serve } from '@hono/node-server';
import { createApp } from './app.ts';

// Render injects PORT; 3000 is for local runs.
const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(
    JSON.stringify({ event: 'listening', port: info.port, at: new Date().toISOString() }),
  );
});

// Render sends SIGTERM before stopping an instance; finish open requests first.
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
