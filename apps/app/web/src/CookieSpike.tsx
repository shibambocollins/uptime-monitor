import { useState } from 'react';

// SPIKE (Phase 0 P7, remove after Phase 0): a page served from the Worker's static assets
// that sets a cookie through the API and checks that the next API call carries it back.

type Step = { label: string; status: number; body: unknown };

const ENDPOINT = '/api/v1/spike/cookie';

export function CookieSpike() {
  const [steps, setSteps] = useState<Step[]>([]);

  async function call(label: string, method: 'GET' | 'POST' | 'DELETE') {
    // Same origin, so fetch's default credentials mode ("same-origin") sends the cookie.
    const response = await fetch(ENDPOINT, { method });
    const body: unknown = await response.json();
    setSteps((previous) => [...previous, { label, status: response.status, body }]);
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '2rem auto' }}>
      <h1>Same-origin cookie spike (P7)</h1>
      <p>
        Pass: after <em>Set cookie</em>, <em>Check cookie</em> reports <code>received: true</code>,
        and <code>document.cookie</code> stays empty because the cookie is HttpOnly. Confirm the
        attributes in dev tools (Application → Cookies).
      </p>
      <p>
        <button onClick={() => call('Set cookie', 'POST')}>Set cookie</button>{' '}
        <button onClick={() => call('Check cookie', 'GET')}>Check cookie</button>{' '}
        <button onClick={() => call('Clear cookie', 'DELETE')}>Clear cookie</button>
      </p>
      <p>
        <code>document.cookie</code>: <code>{JSON.stringify(document.cookie)}</code>
      </p>
      <ol>
        {steps.map((step, i) => (
          <li key={i}>
            {step.label}: HTTP {step.status} <code>{JSON.stringify(step.body)}</code>
          </li>
        ))}
      </ol>
    </main>
  );
}
