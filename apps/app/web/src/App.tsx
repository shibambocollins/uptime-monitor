// Placeholder until the dashboard is built. Served from the Worker's static assets, on the
// same origin as /api/v1 (CLAUDE.md §3).
export function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '2rem auto' }}>
      <h1>Health Monitor</h1>
      <p>
        The dashboard is not built yet. The checker runs every minute; its health endpoint is{' '}
        <a href="/api/v1/health">/api/v1/health</a>.
      </p>
    </main>
  );
}
