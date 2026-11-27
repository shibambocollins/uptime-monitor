import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createSession } from '../src/auth/sessions';
import { upsertGithubUser } from '../src/auth/users';
import { claimDueMonitors } from '../src/checker/claim';
import { checkGroup } from '../src/checker/group';
import type { FetchFn } from '../src/checker/run-checks';
import { MAX_BODY_BYTES } from '../src/http/validate';
import { MAX_MONITORS_PER_TEAM } from '../src/monitors/routes';
import { MAX_PROJECTS_PER_TEAM } from '../src/projects/routes';
import { resetDb } from './fixtures';

const T0 = Date.UTC(2026, 10, 27, 12, 0, 0);
const noFetch: FetchFn = async () => {
  throw new Error('the API must not make outbound requests');
};
const app = createApp({ fetch: noFetch, now: () => T0 });

// --- People and teams ---

interface Person {
  userId: number;
  teamId: number;
  cookie: string;
}

let alice: Person; // OWNER of team A
let bob: Person; // OWNER of team B: must never see team A
let carol: Person; // VIEWER in team A
let dave: Person; // MEMBER of team A

async function person(githubId: number, login: string): Promise<Person> {
  const { userId } = await upsertGithubUser(
    env.DB,
    { id: githubId, login, name: null, avatarUrl: null },
    T0,
  );
  const team = await env.DB.prepare(`SELECT team_id FROM team_members WHERE user_id = ?1`)
    .bind(userId)
    .first<{ team_id: number }>();
  const { token } = await createSession(env.DB, userId, T0);
  return { userId, teamId: team!.team_id, cookie: `__Host-session=${token}` };
}

async function joinTeam(who: Person, teamId: number, role: 'MEMBER' | 'VIEWER') {
  await env.DB.prepare(
    `INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(teamId, who.userId, role, T0)
    .run();
}

beforeEach(async () => {
  await resetDb();
  alice = await person(1, 'alice');
  bob = await person(2, 'bob');
  carol = await person(3, 'carol');
  dave = await person(4, 'dave');
  await joinTeam(carol, alice.teamId, 'VIEWER');
  await joinTeam(dave, alice.teamId, 'MEMBER');
});

// --- Requests ---

function call(who: Person | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (who) headers.Cookie = who.cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(
    `/api/v1${path}`,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
}

// `any` because the tests then assert the exact shape with toEqual, which checks more than
// a type annotation would.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json<T = Record<string, any>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function createProject(who: Person, name = 'Shop') {
  const response = await call(who, 'POST', `/teams/${who.teamId}/projects`, { name });
  expect(response.status).toBe(201);
  return (await json(response)).project as { id: number };
}

async function createMonitor(who: Person, projectId: number, extra: object = {}) {
  const response = await call(who, 'POST', `/projects/${projectId}/monitors`, {
    name: 'Home page',
    url: 'https://shop.example.com/',
    ...extra,
  });
  expect(response.status).toBe(201);
  return (await json(response)).monitor as { id: number };
}

const one = <T>(sql: string, ...values: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...values)
    .first<T>();
const count = async (sql: string, ...values: unknown[]) =>
  (await one<{ n: number }>(sql, ...values))!.n;

const errorCode = async (response: Response) => (await json(response)).error.code;

// --- Tests ---

describe('authentication', () => {
  it.each([
    ['GET', '/teams/1/projects'],
    ['POST', '/teams/1/projects'],
    ['GET', '/projects/1'],
    ['PATCH', '/projects/1'],
    ['DELETE', '/projects/1'],
    ['GET', '/projects/1/monitors'],
    ['POST', '/projects/1/monitors'],
    ['GET', '/monitors/1'],
    ['PATCH', '/monitors/1'],
    ['DELETE', '/monitors/1'],
  ])('%s %s needs a session', async (method, path) => {
    const response = await call(null, method, path, method === 'GET' ? undefined : {});
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('UNAUTHENTICATED');
  });

  it('leaves health and the login start public', async () => {
    expect((await call(null, 'GET', '/health')).status).toBe(200);
    expect((await call(null, 'GET', '/auth/github/login')).status).toBe(302);
  });
});

describe('projects', () => {
  it('creates, lists, renames and shows a project, as DTOs', async () => {
    const created = await call(alice, 'POST', `/teams/${alice.teamId}/projects`, {
      name: '  Shop  ',
    });
    expect(created.status).toBe(201);
    const { project } = await json(created);
    expect(project).toEqual({
      id: expect.any(Number),
      teamId: alice.teamId,
      name: 'Shop',
      createdAt: T0,
      updatedAt: T0,
    });

    const list = await json(await call(alice, 'GET', `/teams/${alice.teamId}/projects`));
    expect(list).toEqual({ projects: [project] });

    const renamed = await call(alice, 'PATCH', `/projects/${project.id}`, { name: 'Store' });
    expect((await json(renamed)).project.name).toBe('Store');
    expect((await json(await call(alice, 'GET', `/projects/${project.id}`))).project.name).toBe(
      'Store',
    );
  });

  it('rejects invalid names and unknown fields, saying which field is wrong', async () => {
    const path = `/teams/${alice.teamId}/projects`;
    for (const body of [
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { name: 5 },
      {},
    ]) {
      const response = await call(alice, 'POST', path, body);
      expect(response.status).toBe(400);
      const { error } = await json(response);
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.details).toEqual([{ field: 'name', message: expect.any(String) }]);
    }
    const extra = await call(alice, 'POST', path, { name: 'Shop', team_id: bob.teamId });
    expect(extra.status).toBe(400);
    expect(await count(`SELECT count(*) AS n FROM projects`)).toBe(0);
  });

  it(`stops at ${MAX_PROJECTS_PER_TEAM} live projects per team`, async () => {
    for (let i = 0; i < MAX_PROJECTS_PER_TEAM; i++) await createProject(alice, `P${i}`);
    const response = await call(alice, 'POST', `/teams/${alice.teamId}/projects`, {
      name: 'One more',
    });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('LIMIT_REACHED');
    // Other teams have their own allowance.
    await createProject(bob);
  });

  it('soft-deletes a project, hides it and its monitors, and stops them being checked', async () => {
    const project = await createProject(alice);
    const monitor = await createMonitor(alice, project.id);

    const response = await call(alice, 'DELETE', `/projects/${project.id}`);
    expect(response.status).toBe(204);

    expect((await call(alice, 'GET', `/projects/${project.id}`)).status).toBe(404);
    expect((await call(alice, 'GET', `/monitors/${monitor.id}`)).status).toBe(404);
    expect(
      (await json(await call(alice, 'GET', `/teams/${alice.teamId}/projects`))).projects,
    ).toEqual([]);
    // Kept for the purge, but disabled, so the claim skips it.
    expect(await one(`SELECT deleted_at FROM projects WHERE id = ?1`, project.id)).toEqual({
      deleted_at: T0,
    });
    expect((await claimDueMonitors(env.DB, T0, 40)).monitors).toEqual([]);
    // A deleted project no longer counts towards the cap.
    for (let i = 0; i < MAX_PROJECTS_PER_TEAM; i++) await createProject(alice, `P${i}`);
  });
});

describe('roles', () => {
  it('lets a VIEWER read but not write', async () => {
    const project = await createProject(alice);
    const monitor = await createMonitor(alice, project.id);

    expect((await call(carol, 'GET', `/teams/${alice.teamId}/projects`)).status).toBe(200);
    expect((await call(carol, 'GET', `/projects/${project.id}/monitors`)).status).toBe(200);
    expect((await call(carol, 'GET', `/monitors/${monitor.id}`)).status).toBe(200);

    const writes = [
      call(carol, 'POST', `/teams/${alice.teamId}/projects`, { name: 'X' }),
      call(carol, 'PATCH', `/projects/${project.id}`, { name: 'X' }),
      call(carol, 'DELETE', `/projects/${project.id}`),
      call(carol, 'POST', `/projects/${project.id}/monitors`, {
        name: 'X',
        url: 'https://x.example/',
      }),
      call(carol, 'PATCH', `/monitors/${monitor.id}`, { name: 'X' }),
      call(carol, 'DELETE', `/monitors/${monitor.id}`),
    ];
    for (const response of await Promise.all(writes)) {
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('FORBIDDEN');
    }
    expect(await count(`SELECT count(*) AS n FROM projects WHERE name = 'X'`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM monitors WHERE name = 'Home page'`)).toBe(1);
  });

  it('lets a MEMBER manage monitors but only an OWNER delete a project', async () => {
    // Team A, where dave is a MEMBER (dave.teamId is his own personal team).
    const created = await call(dave, 'POST', `/teams/${alice.teamId}/projects`, { name: 'D' });
    expect(created.status).toBe(201);
    const project = (await json(created)).project as { id: number };
    const monitor = await createMonitor(dave, project.id);
    expect((await call(dave, 'PATCH', `/monitors/${monitor.id}`, { name: 'Y' })).status).toBe(200);
    expect((await call(dave, 'DELETE', `/projects/${project.id}`)).status).toBe(403);
    expect((await call(alice, 'DELETE', `/projects/${project.id}`)).status).toBe(204);
  });
});

describe('team isolation: another team gets 404 and changes nothing', () => {
  it('on every route', async () => {
    const project = await createProject(alice);
    const monitor = await createMonitor(alice, project.id);
    const before = await env.DB.prepare(
      `SELECT (SELECT json_group_array(json_object('n', name, 'u', updated_at, 'd', deleted_at)) FROM projects) AS p,
              (SELECT json_group_array(json_object('n', name, 'e', enabled, 'u', url)) FROM monitors) AS m`,
    ).first();

    const attempts: [string, string, unknown?][] = [
      ['GET', `/teams/${alice.teamId}/projects`],
      ['POST', `/teams/${alice.teamId}/projects`, { name: 'Mine now' }],
      ['GET', `/projects/${project.id}`],
      ['PATCH', `/projects/${project.id}`, { name: 'Mine now' }],
      ['DELETE', `/projects/${project.id}`],
      ['GET', `/projects/${project.id}/monitors`],
      ['POST', `/projects/${project.id}/monitors`, { name: 'Mine', url: 'https://bob.example/' }],
      ['GET', `/monitors/${monitor.id}`],
      ['PATCH', `/monitors/${monitor.id}`, { url: 'https://bob.example/' }],
      ['DELETE', `/monitors/${monitor.id}`],
    ];
    for (const [method, path, body] of attempts) {
      const response = await call(bob, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await json(response), `${method} ${path}`).toEqual({
        error: { code: 'NOT_FOUND', message: 'Not found.' },
      });
    }

    const after = await env.DB.prepare(
      `SELECT (SELECT json_group_array(json_object('n', name, 'u', updated_at, 'd', deleted_at)) FROM projects) AS p,
              (SELECT json_group_array(json_object('n', name, 'e', enabled, 'u', url)) FROM monitors) AS m`,
    ).first();
    expect(after).toEqual(before);
  });

  it('answers an id that does not exist the same way as another team’s', async () => {
    const theirs = await createProject(bob);
    const a = await call(alice, 'GET', `/projects/${theirs.id}`);
    const b = await call(alice, 'GET', `/projects/${theirs.id + 1000}`);
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(await a.text()).toBe(await b.text());
  });

  it.each(['abc', '0', '01', '-1', '1.5', '99999999999999999999'])(
    'answers 404 for the malformed id %s',
    async (id) => {
      expect((await call(alice, 'GET', `/projects/${id}`)).status).toBe(404);
      expect((await call(alice, 'GET', `/monitors/${id}`)).status).toBe(404);
    },
  );
});

describe('monitors', () => {
  it('creates a monitor with defaults, due on the next tick', async () => {
    const project = await createProject(alice);
    const response = await call(alice, 'POST', `/projects/${project.id}/monitors`, {
      name: 'API',
      url: 'HTTPS://Shop.Example.COM/health',
    });
    expect(response.status).toBe(201);
    const { monitor } = await json(response);
    expect(monitor).toEqual({
      id: expect.any(Number),
      projectId: project.id,
      name: 'API',
      url: 'https://shop.example.com/health', // the URL parser's normalised form
      intervalSeconds: 300,
      timeoutMs: 10_000,
      latencyThresholdMs: 2_000,
      expectedStatus: 200,
      enabled: true,
      state: 'UP',
      createdAt: T0,
      updatedAt: T0,
    });
    expect(await one(`SELECT next_run_at FROM monitors WHERE id = ?1`, monitor.id)).toEqual({
      next_run_at: 0,
    });
    const list = await json(await call(alice, 'GET', `/projects/${project.id}/monitors`));
    expect(list).toEqual({ monitors: [monitor] });
  });

  it.each([
    ['http://127.0.0.1/', 'BLOCKED_ADDRESS'],
    ['http://169.254.169.254/latest/meta-data/', 'BLOCKED_ADDRESS'],
    ['http://[::1]/', 'BLOCKED_ADDRESS'],
    ['http://2130706433/', 'BLOCKED_ADDRESS'],
    ['http://localhost:8787/', 'INTERNAL_HOSTNAME'],
    ['http://printer.local/', 'INTERNAL_HOSTNAME'],
    ['ftp://files.example.com/', 'UNSUPPORTED_SCHEME'],
    ['https://user:pass@shop.example.com/', 'CREDENTIALS'],
    ['not a url', 'INVALID_URL'],
  ])('rejects %s (SSRF rules, CLAUDE.md §8)', async (url) => {
    const project = await createProject(alice);
    const response = await call(alice, 'POST', `/projects/${project.id}/monitors`, {
      name: 'Bad',
      url,
    });
    expect(response.status).toBe(400);
    const { error } = await json(response);
    expect(error.code).toBe('URL_NOT_ALLOWED');
    expect(error.details).toEqual([{ field: 'url', message: expect.any(String) }]);
    expect(await count(`SELECT count(*) AS n FROM monitors`)).toBe(0);
  });

  it.each([
    [{ intervalSeconds: 60 }, 'intervalSeconds'],
    [{ intervalSeconds: 300.5 }, 'intervalSeconds'],
    [{ timeoutMs: 30_000 }, 'timeoutMs'],
    [{ latencyThresholdMs: 0 }, 'latencyThresholdMs'],
    [{ expectedStatus: 99 }, 'expectedStatus'],
    [{ enabled: 'yes' }, 'enabled'],
    [{ url: 'x'.repeat(2049) }, 'url'],
  ])('rejects %o', async (extra, field) => {
    const project = await createProject(alice);
    const response = await call(alice, 'POST', `/projects/${project.id}/monitors`, {
      name: 'Bad',
      url: 'https://shop.example.com/',
      ...extra,
    });
    expect(response.status).toBe(400);
    expect((await json(response)).error.details).toEqual([{ field, message: expect.any(String) }]);
  });

  it(`stops at ${MAX_MONITORS_PER_TEAM} monitors per team, across its projects`, async () => {
    const first = await createProject(alice, 'First');
    const second = await createProject(alice, 'Second');
    for (let i = 0; i < MAX_MONITORS_PER_TEAM; i++) {
      await createMonitor(alice, i % 2 ? first.id : second.id);
    }
    const response = await call(alice, 'POST', `/projects/${first.id}/monitors`, {
      name: 'One more',
      url: 'https://shop.example.com/',
    });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('LIMIT_REACHED');
    await createMonitor(bob, (await createProject(bob)).id);
  });

  it('updates only the fields sent', async () => {
    const project = await createProject(alice);
    const monitor = await createMonitor(alice, project.id);
    const response = await call(alice, 'PATCH', `/monitors/${monitor.id}`, {
      name: 'Checkout',
      intervalSeconds: 600,
      enabled: false,
    });
    expect(response.status).toBe(200);
    expect((await json(response)).monitor).toMatchObject({
      name: 'Checkout',
      intervalSeconds: 600,
      enabled: false,
      url: 'https://shop.example.com/',
      timeoutMs: 10_000,
    });
  });

  it('starts a monitor over when its URL changes', async () => {
    const project = await createProject(alice);
    const monitor = await createMonitor(alice, project.id);
    await env.DB.prepare(
      `UPDATE monitors SET state = 'DOWN', consecutive_successes = 1, next_run_at = ?2 WHERE id = ?1`,
    )
      .bind(monitor.id, T0 + 300_000)
      .run();

    const response = await call(alice, 'PATCH', `/monitors/${monitor.id}`, {
      url: 'https://new.example.com/',
    });
    expect((await json(response)).monitor).toMatchObject({
      url: 'https://new.example.com/',
      state: 'UP',
    });
    expect(
      await one(
        `SELECT consecutive_failures, consecutive_slow, consecutive_successes, next_run_at
         FROM monitors WHERE id = ?1`,
        monitor.id,
      ),
    ).toEqual({
      consecutive_failures: 0,
      consecutive_slow: 0,
      consecutive_successes: 0,
      next_run_at: 0,
    });
  });

  it('keeps the state when other fields change, and checks a re-enabled monitor next tick', async () => {
    const project = await createProject(alice);
    const monitor = await createMonitor(alice, project.id, { enabled: false });
    await env.DB.prepare(`UPDATE monitors SET state = 'DOWN', next_run_at = ?2 WHERE id = ?1`)
      .bind(monitor.id, T0 + 300_000)
      .run();

    await call(alice, 'PATCH', `/monitors/${monitor.id}`, { name: 'Renamed' });
    expect(await one(`SELECT state, next_run_at FROM monitors WHERE id = ?1`, monitor.id)).toEqual({
      state: 'DOWN',
      next_run_at: T0 + 300_000,
    });

    await call(alice, 'PATCH', `/monitors/${monitor.id}`, { enabled: true });
    expect(await one(`SELECT state, next_run_at FROM monitors WHERE id = ?1`, monitor.id)).toEqual({
      state: 'DOWN',
      next_run_at: 0,
    });
  });

  it('validates a PATCH like a create', async () => {
    const project = await createProject(alice);
    const monitor = await createMonitor(alice, project.id);
    for (const body of [
      {},
      { url: 'http://10.0.0.1/' },
      { intervalSeconds: 30 },
      { state: 'UP' },
    ]) {
      expect((await call(alice, 'PATCH', `/monitors/${monitor.id}`, body)).status).toBe(400);
    }
    expect(
      await one(`SELECT url, interval_seconds FROM monitors WHERE id = ?1`, monitor.id),
    ).toEqual({ url: 'https://shop.example.com/', interval_seconds: 300 });
  });

  it('deletes a monitor with its rollups and events', async () => {
    const project = await createProject(alice);
    const monitor = await createMonitor(alice, project.id);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO check_rollups_hourly (monitor_id, hour, total, failures, latency_sum_ms,
           lt_250, lt_500, lt_1000, lt_2500, lt_5000, ge_5000)
         VALUES (?1, ?2, 1, 1, 0, 0, 0, 0, 0, 0, 0)`,
      ).bind(monitor.id, T0),
      env.DB.prepare(
        `INSERT INTO check_events (monitor_id, checked_at, success, state) VALUES (?1, ?2, 0, 'UP')`,
      ).bind(monitor.id, T0),
    ]);

    expect((await call(alice, 'DELETE', `/monitors/${monitor.id}`)).status).toBe(204);
    expect((await call(alice, 'GET', `/monitors/${monitor.id}`)).status).toBe(404);
    expect(await count(`SELECT count(*) AS n FROM check_rollups_hourly`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM check_events`)).toBe(0);
  });
});

describe('request bodies', () => {
  it('requires application/json, which a cross-site form cannot send', async () => {
    const response = await app.request(
      `/api/v1/teams/${alice.teamId}/projects`,
      {
        method: 'POST',
        headers: { Cookie: alice.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'name=Shop',
      },
      env,
    );
    expect(response.status).toBe(415);
    expect(await count(`SELECT count(*) AS n FROM projects`)).toBe(0);
  });

  it('rejects malformed JSON and oversized bodies', async () => {
    const send = (body: string) =>
      app.request(
        `/api/v1/teams/${alice.teamId}/projects`,
        {
          method: 'POST',
          headers: { Cookie: alice.cookie, 'Content-Type': 'application/json' },
          body,
        },
        env,
      );
    const malformed = await send('{"name": ');
    expect([malformed.status, await errorCode(malformed)]).toEqual([400, 'INVALID_JSON']);
    const huge = await send(JSON.stringify({ name: 'x'.repeat(MAX_BODY_BYTES) }));
    expect([huge.status, await errorCode(huge)]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
  });
});

describe('a monitor deleted while its check is in flight', () => {
  it('writes nothing for it and still records the rest of the group', async () => {
    const project = await createProject(alice);
    const kept = await createMonitor(alice, project.id);
    const deleted = await createMonitor(alice, project.id);
    const { monitors } = await claimDueMonitors(env.DB, T0, 40);
    expect(monitors).toHaveLength(2);

    await call(alice, 'DELETE', `/monitors/${deleted.id}`);
    // A failing check: the rollup and an event would be written for both monitors.
    const result = await checkGroup(monitors, {
      db: env.DB,
      fetch: async () => new Response(null, { status: 500 }),
      now: () => T0,
    });

    expect(result.checkedIds).toEqual([kept.id, deleted.id]);
    expect(
      await count(`SELECT count(*) AS n FROM check_rollups_hourly WHERE monitor_id = ?1`, kept.id),
    ).toBe(1);
    expect(
      await count(`SELECT count(*) AS n FROM check_events WHERE monitor_id = ?1`, kept.id),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*) AS n FROM check_rollups_hourly WHERE monitor_id = ?1`,
        deleted.id,
      ),
    ).toBe(0);
    expect(
      await count(`SELECT count(*) AS n FROM check_events WHERE monitor_id = ?1`, deleted.id),
    ).toBe(0);
  });
});
