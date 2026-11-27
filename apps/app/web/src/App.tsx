import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type Channel,
  type Incident,
  type Me,
  type Monitor,
  type MonitorStatus,
  type Project,
  type Role,
  type TeamStatus,
} from './api';

// The dashboard: one page, the same plain look as the developer's portfolio. Everything is
// read from /api/v1 and refreshed every minute, the checker's own pace.

const REFRESH_MS = 60_000;
const SOURCE_URL = 'https://github.com/shibambocollins';
const INTERVALS = [5, 10, 15, 30, 60];

const LOGIN_ERRORS: Record<string, string> = {
  denied: 'You cancelled the GitHub sign-in.',
  state_mismatch: 'The sign-in expired or was started in another tab. Try again.',
};

export function App() {
  const [me, setMe] = useState<Me | 'signed-out' | 'error' | null>(null);

  useEffect(() => {
    api<Me>('GET', '/me')
      .then(setMe)
      .catch((error: unknown) =>
        setMe(error instanceof ApiError && error.status === 401 ? 'signed-out' : 'error'),
      );
  }, []);

  if (me === null) return <Shell>{null}</Shell>;
  if (me === 'error') {
    return (
      <Shell>
        <section className="intro">
          <h1>Something went wrong.</h1>
          <p className="muted">The API did not answer. Reload the page in a minute.</p>
        </section>
      </Shell>
    );
  }
  if (me === 'signed-out') return <SignedOut />;
  return <Dashboard me={me} />;
}

function Shell({ nav, children }: { nav?: ReactNode; children: ReactNode }) {
  return (
    <>
      <header className="wrap top">
        <a className="wordmark" href="/">
          health monitor
        </a>
        {nav}
      </header>
      <main className="wrap">{children}</main>
      <footer className="wrap foot small muted">
        <p>
          Checks run every minute on Cloudflare Workers. A portfolio project, not a replacement for
          a commercial uptime service. <a href={SOURCE_URL}>Source ↗</a>
        </p>
      </footer>
    </>
  );
}

function SignedOut() {
  const code = new URLSearchParams(location.search).get('login_error');
  return (
    <Shell>
      <section className="intro">
        <h1>Know when your app goes down, before your users do.</h1>
        <p className="muted">
          Add the URLs you care about. They are checked every few minutes, and you get a Discord
          message when one goes down and when it comes back.
        </p>
        {code && <p className="error">{LOGIN_ERRORS[code] ?? 'Sign-in failed. Try again.'}</p>}
        <a className="btn" href="/api/v1/auth/github/login">
          Sign in with GitHub
        </a>
        <p className="small muted">Only your public GitHub profile is read. No password.</p>
      </section>
    </Shell>
  );
}

// --- Dashboard ---

interface Data {
  projects: Project[];
  monitors: Monitor[];
  channels: Channel[];
  status: TeamStatus;
}

function Dashboard({ me }: { me: Me }) {
  const [teamId, setTeamId] = useState(me.teams[0]?.id ?? 0);
  const team = me.teams.find((t) => t.id === teamId);
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ projects }, { channels }, status] = await Promise.all([
        api<{ projects: Project[] }>('GET', `/teams/${teamId}/projects`),
        api<{ channels: Channel[] }>('GET', `/teams/${teamId}/channels`),
        api<TeamStatus>('GET', `/teams/${teamId}/status`),
      ]);
      const lists = await Promise.all(
        projects.map((p) => api<{ monitors: Monitor[] }>('GET', `/projects/${p.id}/monitors`)),
      );
      setData({ projects, channels, status, monitors: lists.flatMap((l) => l.monitors) });
      setLoadError(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) location.reload();
      setLoadError(error instanceof ApiError ? error.text : 'Could not load the dashboard.');
    }
  }, [teamId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const signOut = async () => {
    await api('POST', '/auth/logout').catch(() => undefined);
    location.assign('/');
  };

  const nav = (
    <nav className="nav" aria-label="Sections">
      <a href="#monitors">monitors</a>
      <a href="#alerts">alerts</a>
      <a href="#incidents">incidents</a>
      <button type="button" className="textbtn" onClick={() => void signOut()}>
        sign out {me.user.login}
      </button>
    </nav>
  );

  if (!team) {
    return (
      <Shell nav={nav}>
        <section className="intro">
          <h1>You are not in a team.</h1>
        </section>
      </Shell>
    );
  }
  const writable = team.role !== 'VIEWER';

  return (
    <Shell nav={nav}>
      <Summary team={team} teams={me.teams} onTeam={setTeamId} data={data} loadError={loadError} />
      {data && (
        <>
          <MonitorsSection data={data} role={team.role} teamId={teamId} reload={load} />
          <AlertsSection
            channels={data.channels}
            writable={writable}
            teamId={teamId}
            reload={load}
          />
          <IncidentsSection incidents={data.status.incidents} />
        </>
      )}
    </Shell>
  );
}

function Summary(props: {
  team: Me['teams'][number];
  teams: Me['teams'];
  onTeam: (id: number) => void;
  data: Data | null;
  loadError: string | null;
}) {
  const { data } = props;
  const enabled = data?.monitors.filter((m) => m.enabled) ?? [];
  const down = enabled.filter((m) => m.state === 'DOWN').length;
  const slow = enabled.filter((m) => m.state === 'DEGRADED').length;
  const uptimes = data?.status.monitors.flatMap((s) => (s.uptime24h === null ? [] : [s])) ?? [];
  const checks = uptimes.reduce((n, s) => n + s.checks24h, 0);
  const ok = uptimes.reduce((n, s) => n + (s.uptime24h ?? 0) * s.checks24h, 0);
  const working = data?.channels.filter((c) => c.enabled && !c.brokenAt).length ?? 0;

  const headline = !data
    ? 'Loading…'
    : enabled.length === 0
      ? 'Nothing is being monitored yet.'
      : down > 0
        ? `${down} of ${enabled.length} ${plural(enabled.length, 'monitor')} ${down === 1 ? 'is' : 'are'} down.`
        : slow > 0
          ? `All up, ${slow} slow.`
          : `All ${enabled.length} ${plural(enabled.length, 'monitor')} up.`;

  return (
    <section className="intro">
      <span className="kind">{props.team.name}</span>
      <h1>{headline}</h1>
      {props.loadError && <p className="error">{props.loadError}</p>}
      {props.teams.length > 1 && (
        <div className="field">
          <label htmlFor="team">Team</label>
          <select
            id="team"
            value={props.team.id}
            onChange={(e) => props.onTeam(Number(e.target.value))}
          >
            {props.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {data && (
        <dl className="tiles">
          <div className="tile">
            <dt>Uptime 24 h</dt>
            <dd>{checks > 0 ? percent(ok / checks) : '–'}</dd>
          </div>
          <div className="tile">
            <dt>Down now</dt>
            <dd>{down}</dd>
          </div>
          <div className="tile">
            <dt>Alert channels</dt>
            <dd>{working > 0 ? `${working} working` : 'none'}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}

// --- Monitors ---

function MonitorsSection(props: {
  data: Data;
  role: Role;
  teamId: number;
  reload: () => Promise<void>;
}) {
  const { data, role } = props;
  const writable = role !== 'VIEWER';
  const statusById = new Map(data.status.monitors.map((s) => [s.monitorId, s]));
  const [addingProject, setAddingProject] = useState(false);
  const first = data.projects.length === 0;

  return (
    <Panel
      id="monitors"
      title="monitors"
      count={data.monitors.length}
      action={
        writable && !first && !addingProject ? (
          <button type="button" className="textbtn" onClick={() => setAddingProject(true)}>
            add project
          </button>
        ) : null
      }
    >
      {first && (
        <p className="lead">
          Monitors live in projects. Start with a project, for example the name of your app.
        </p>
      )}
      {data.projects.map((project) => (
        <ProjectGroup
          key={project.id}
          project={project}
          monitors={data.monitors.filter((m) => m.projectId === project.id)}
          statusById={statusById}
          role={role}
          reload={props.reload}
        />
      ))}
      {writable && (first || addingProject) && (
        <AddProject
          teamId={props.teamId}
          onCancel={first ? undefined : () => setAddingProject(false)}
          reload={async () => {
            setAddingProject(false);
            await props.reload();
          }}
        />
      )}
    </Panel>
  );
}

function ProjectGroup(props: {
  project: Project;
  monitors: Monitor[];
  statusById: Map<number, MonitorStatus>;
  role: Role;
  reload: () => Promise<void>;
}) {
  const { project, monitors } = props;
  const writable = props.role !== 'VIEWER';
  const [adding, setAdding] = useState(monitors.length === 0);
  const remove = useAction(props.reload);

  return (
    <div className="sheet">
      <div className="group-head">
        <h3>{project.name}</h3>
        {writable && (
          <div className="row">
            <button type="button" className="textbtn" onClick={() => setAdding(!adding)}>
              {adding ? 'cancel' : 'add monitor'}
            </button>
            {props.role === 'OWNER' && (
              <ConfirmButton
                label="delete project"
                busy={remove.busy}
                onConfirm={() => remove.run(() => api('DELETE', `/projects/${project.id}`))}
              />
            )}
          </div>
        )}
      </div>
      {remove.error && <p className="error">{remove.error}</p>}
      {monitors.length === 0 ? (
        <p className="small muted sheet-note">No monitors in this project yet.</p>
      ) : (
        <ul className="list">
          {monitors.map((m) => (
            <MonitorItem
              key={m.id}
              monitor={m}
              status={props.statusById.get(m.id)}
              writable={writable}
              reload={props.reload}
            />
          ))}
        </ul>
      )}
      {adding && writable && (
        <AddMonitor
          projectId={project.id}
          reload={async () => {
            setAdding(false);
            await props.reload();
          }}
        />
      )}
    </div>
  );
}

function MonitorItem(props: {
  monitor: Monitor;
  status: MonitorStatus | undefined;
  writable: boolean;
  reload: () => Promise<void>;
}) {
  const { monitor: m, status: s } = props;
  const action = useAction(props.reload);
  const look = stateLook(m, s);

  return (
    <li>
      <div className="list-main">
        <span className="status">
          <span className={`dot ${look.dot}`} aria-hidden="true" />
          <span>{m.name}</span>
          <span className="small muted">{look.label}</span>
        </span>
        <a className="url small muted" href={m.url} rel="noreferrer" target="_blank">
          {m.url}
        </a>
        {props.writable && (
          <div className="row">
            <button
              type="button"
              className="textbtn"
              disabled={action.busy}
              onClick={() =>
                action.run(() => api('PATCH', `/monitors/${m.id}`, { enabled: !m.enabled }))
              }
            >
              {m.enabled ? 'pause' : 'resume'}
            </button>
            <ConfirmButton
              label="delete"
              busy={action.busy}
              onConfirm={() => action.run(() => api('DELETE', `/monitors/${m.id}`))}
            />
          </div>
        )}
        {action.error && <p className="error">{action.error}</p>}
      </div>
      <div className="list-side small">
        <span>{s?.uptime24h != null ? `${percent(s.uptime24h)} up` : '–'}</span>
        <span className="muted">
          {s?.avgLatencyMs24h != null ? `${s.avgLatencyMs24h} ms avg` : 'no checks yet'}
        </span>
        <span className="muted">
          {s?.lastCheckedAt
            ? `checked ${ago(s.lastCheckedAt)}`
            : m.enabled
              ? 'first check soon'
              : ''}
        </span>
      </div>
    </li>
  );
}

function stateLook(m: Monitor, s: MonitorStatus | undefined) {
  if (!m.enabled) return { dot: 'off', label: 'paused' };
  if (!s?.lastCheckedAt) return { dot: '', label: 'waiting for first check' };
  if (m.state === 'DOWN') {
    return { dot: 'down', label: s.downSince ? `down for ${since(s.downSince)}` : 'down' };
  }
  if (m.state === 'DEGRADED') return { dot: 'slow', label: 'slow' };
  return { dot: 'up', label: 'up' };
}

function AddProject(props: { teamId: number; onCancel?: () => void; reload: () => Promise<void> }) {
  const [name, setName] = useState('');
  const save = useAction(props.reload);

  return (
    <Form
      title="New project"
      submit="Add project"
      busy={save.busy}
      error={save.error}
      onSubmit={() => save.run(() => api('POST', `/teams/${props.teamId}/projects`, { name }))}
      onCancel={props.onCancel}
    >
      <Field id="project-name" label="Name">
        <input
          id="project-name"
          required
          maxLength={100}
          placeholder="My shop"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
    </Form>
  );
}

function AddMonitor(props: { projectId: number; reload: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('https://');
  const [minutes, setMinutes] = useState(5);
  const save = useAction(props.reload);

  return (
    <Form
      title="New monitor"
      submit="Add monitor"
      busy={save.busy}
      error={save.error}
      onSubmit={() =>
        save.run(() =>
          api('POST', `/projects/${props.projectId}/monitors`, {
            name,
            url,
            intervalSeconds: minutes * 60,
          }),
        )
      }
    >
      <div className="fields">
        <Field id={`m-name-${props.projectId}`} label="Name">
          <input
            id={`m-name-${props.projectId}`}
            required
            maxLength={100}
            placeholder="Home page"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field id={`m-interval-${props.projectId}`} label="Check every">
          <select
            id={`m-interval-${props.projectId}`}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          >
            {INTERVALS.map((n) => (
              <option key={n} value={n}>
                {n} minutes
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field id={`m-url-${props.projectId}`} label="URL">
        <input
          id={`m-url-${props.projectId}`}
          required
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>
      <p className="small muted">
        Down after 3 failed checks in a row (a status other than 200, a timeout, or no connection).
        Back up after 2 good ones.
      </p>
    </Form>
  );
}

// --- Alerts ---

function AlertsSection(props: {
  channels: Channel[];
  writable: boolean;
  teamId: number;
  reload: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <Panel
      id="alerts"
      title="alerts"
      count={props.channels.length}
      action={
        props.writable && !adding ? (
          <button type="button" className="textbtn" onClick={() => setAdding(true)}>
            add Discord channel
          </button>
        ) : null
      }
    >
      <p className="small muted">
        Every channel here gets a message when any monitor goes down and when it recovers.
      </p>
      <div className="sheet">
        {props.channels.length === 0 ? (
          <p className="small muted sheet-note">
            No channels yet, so nobody is told when something breaks.
          </p>
        ) : (
          <ul className="list">
            {props.channels.map((c) => (
              <ChannelItem key={c.id} channel={c} writable={props.writable} reload={props.reload} />
            ))}
          </ul>
        )}
      </div>
      {props.writable && adding && (
        <AddChannel
          teamId={props.teamId}
          onCancel={() => setAdding(false)}
          reload={async () => {
            setAdding(false);
            await props.reload();
          }}
        />
      )}
    </Panel>
  );
}

function ChannelItem(props: { channel: Channel; writable: boolean; reload: () => Promise<void> }) {
  const { channel: c } = props;
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAction(props.reload);
  const look = c.brokenAt
    ? { dot: 'down', label: 'broken' }
    : c.enabled
      ? { dot: 'up', label: 'working' }
      : { dot: 'off', label: 'off' };

  return (
    <li>
      <div className="list-main">
        <span className="status">
          <span className={`dot ${look.dot}`} aria-hidden="true" />
          <span>{c.name}</span>
          <span className="small muted">{look.label}</span>
        </span>
        <span className="small muted">
          Discord webhook <span className="code">…{c.hint}</span>
        </span>
        {c.brokenReason && (
          <p className="error">{c.brokenReason} Add it again with a new webhook.</p>
        )}
        {props.writable && (
          <div className="row">
            <button
              type="button"
              className="textbtn"
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  setNotice(null);
                  await api('POST', `/channels/${c.id}/test`);
                  setNotice('Test message sent. Check Discord.');
                })
              }
            >
              send test
            </button>
            <button
              type="button"
              className="textbtn"
              disabled={action.busy}
              onClick={() =>
                action.run(() => api('PATCH', `/channels/${c.id}`, { enabled: !c.enabled }))
              }
            >
              {c.enabled ? 'turn off' : 'turn on'}
            </button>
            <ConfirmButton
              label="delete"
              busy={action.busy}
              onConfirm={() => action.run(() => api('DELETE', `/channels/${c.id}`))}
            />
          </div>
        )}
        {notice && <p className="notice">{notice}</p>}
        {action.error && <p className="error">{action.error}</p>}
      </div>
    </li>
  );
}

function AddChannel(props: { teamId: number; onCancel: () => void; reload: () => Promise<void> }) {
  const [name, setName] = useState('Alerts');
  const [webhookUrl, setWebhookUrl] = useState('');
  const save = useAction(props.reload);

  return (
    <Form
      title="New Discord channel"
      submit="Save and send a test message"
      busy={save.busy}
      error={save.error}
      onCancel={props.onCancel}
      onSubmit={() =>
        save.run(() =>
          api('POST', `/teams/${props.teamId}/channels`, { type: 'DISCORD', name, webhookUrl }),
        )
      }
    >
      <Field id="ch-name" label="Name">
        <input
          id="ch-name"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field id="ch-url" label="Webhook URL">
        <input
          id="ch-url"
          required
          type="password"
          autoComplete="off"
          placeholder="https://discord.com/api/webhooks/…"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
        />
      </Field>
      <p className="small muted">
        In Discord: Server settings → Integrations → Webhooks → New Webhook → Copy Webhook URL. It
        is stored encrypted and only its last characters are shown again.
      </p>
    </Form>
  );
}

// --- Incidents ---

function IncidentsSection({ incidents }: { incidents: Incident[] }) {
  return (
    <Panel id="incidents" title="incidents" count={incidents.length}>
      <div className="sheet">
        {incidents.length === 0 ? (
          <p className="small muted sheet-note">No incidents. Each outage will be listed here.</p>
        ) : (
          <ul className="list">
            {incidents.map((i) => (
              <li key={i.id}>
                <div className="list-main">
                  <span className="status">
                    <span className={`dot ${i.resolvedAt ? 'off' : 'ink'}`} aria-hidden="true" />
                    <span>{i.monitorName}</span>
                  </span>
                  <span className="small muted">{i.cause ?? 'unknown cause'}</span>
                </div>
                <div className="list-side small">
                  <span>
                    {i.resolvedAt ? `down ${span(i.resolvedAt - i.startedAt)}` : 'ongoing'}
                  </span>
                  <span className="muted">{when(i.startedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

// --- Small pieces ---

/** One dashboard section: a grey panel with a title, a count and an optional action. */
function Panel(props: {
  id: string;
  title: string;
  count: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel" id={props.id} aria-labelledby={`${props.id}-title`}>
      <div className="panel-head">
        <div className="panel-title">
          <h2 id={`${props.id}-title`}>{props.title}</h2>
          <span className="count">{props.count}</span>
        </div>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

/** Runs an API call, shows its error, then reloads the data. */
function useAction(after: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await call();
      await after();
    } catch (e) {
      setError(e instanceof ApiError ? e.text : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** Two clicks to delete, without a browser dialog. */
function ConfirmButton(props: { label: string; busy: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => setAsking(false), 5000);
    return () => clearTimeout(timer);
  }, [asking]);
  if (!asking) {
    return (
      <button
        type="button"
        className="textbtn"
        disabled={props.busy}
        onClick={() => setAsking(true)}
      >
        {props.label}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="textbtn danger"
      disabled={props.busy}
      onClick={() => {
        setAsking(false);
        props.onConfirm();
      }}
    >
      click again to {props.label}
    </button>
  );
}

function Form(props: {
  title: string;
  submit: string;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onCancel?: () => void;
  children: ReactNode;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    props.onSubmit();
  };
  return (
    <form className="card" onSubmit={submit}>
      <h3>{props.title}</h3>
      {props.children}
      {props.error && (
        <p className="error" role="alert">
          {props.error}
        </p>
      )}
      <div className="row">
        <button className="btn" type="submit" disabled={props.busy}>
          {props.busy ? 'Saving…' : props.submit}
        </button>
        {props.onCancel && (
          <button type="button" className="textbtn" onClick={props.onCancel}>
            cancel
          </button>
        )}
      </div>
    </form>
  );
}

function Field(props: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      {props.children}
    </div>
  );
}

// --- Formatting ---

const plural = (n: number, word: string, withCount = false) =>
  `${withCount ? `${n} ` : ''}${word}${n === 1 ? '' : 's'}`;

/** 99.95%, 100%, 87.5%: two decimals at most, no trailing zeros. */
const percent = (ratio: number) => `${Number((ratio * 100).toFixed(2))}%`;

/** "45 s", "3 min", "2 h 5 min", "1 d 3 h" (the same as the Discord messages). */
function span(ms: number): string {
  const s = Math.max(Math.round(ms / 1000), 0);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

const since = (time: number) => span(Date.now() - time);

function ago(time: number) {
  const ms = Date.now() - time;
  return ms < 60_000 ? 'just now' : `${span(ms)} ago`;
}

const when = (time: number) =>
  new Date(time).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
