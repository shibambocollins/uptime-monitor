import { Hono } from 'hono';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/v1/health', (c) => c.json({ status: 'ok' }));

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
