# Phase 0 checklist: Option B spike

**Question this answers:** do the Cloudflare free-plan limits (10 ms CPU, 50 subrequests, 6 concurrent connections, 50 D1 queries per invocation, 100,000 D1 rows written per day) leave enough room for the checker? If yes, build on it. If no, reduce work per tick, then rethink the write model, then fall back to Option A (CLAUDE.md §9).

**Time-box:** about two evenings of build work, then a 1-hour burst test and a 24-hour soak that run unattended.

**Rule:** the thresholds in section 3 are proposals. Edit them before the first deploy, then freeze them. Changing a threshold after seeing the result turns the test into a rationalisation.

The Option A version of this checklist is in git history (commit `d1c9c73`).

## 1. Facts this spike relies on (checked 2026-10-15 and 2026-10-19)

Sources and details: DECISIONS.md §10 and CLAUDE.md §5. In short:
- Workers Free: 100,000 requests/day; 10 ms CPU per invocation (waiting on `fetch()` doesn't count); 50 subrequests; 6 connections waiting for headers at once; cron wall time 15 minutes.
- D1 Free: 100,000 rows written/day (deletes count, and a write to an indexed column adds at least one more row); 5 million read; 50 queries per invocation; queries fail until 00:00 UTC once a daily limit is hit.
- Static asset requests are free and unlimited.
- A Worker can't reliably `fetch()` another Worker on the same account by URL, which is why `chaos-target` runs on Render.
- Render free: sleeps after 15 minutes without inbound traffic, about one minute to wake, 750 hours per workspace.

**Unverified, settled by this spike:** whether a `db.batch()` counts as one query or many toward the 50; real CPU per tick; real rows written per check; what `fetch()` does with private and loopback addresses.

## 2. Why the tests are split into a burst and a soak

The soak cannot run at full load: 40 checks a minute for 24 hours at 2 rows per check is 115,200 rows, over the daily write cap. So:
- **Burst (1 hour, 40 checks per tick):** tests CPU, subrequests, query count and concurrency at the per-invocation ceiling. About 4,800 rows written.
- **Soak (24 hours, 10 checks per tick):** tests reliability and the real write rate. About 28,800 rows written by checks plus 1,440 by the per-tick counter (about 30% of the cap).

## 3. Pass criteria (proposed: edit, then freeze)

All must hold. Record measurements in section 6.

| # | Criterion | Threshold | How to measure |
|---|---|---|---|
| P1 | Ticks run | ≥ 1,426 of 1,440 cron invocations in the soak complete without error (99%) | Workers dashboard invocations and errors; tick log lines |
| P2 | CPU fits | 0 CPU-limit errors in burst and soak; p99 CPU per invocation ≤ 7 ms at 40 checks (30% headroom) | Workers dashboard CPU time |
| P3 | Per-invocation budgets fit | A burst tick does 40 checks + 1 Discord call + its D1 work with 0 subrequest or query-limit errors | Tick logs; error count |
| P4 | Latency is measured honestly | With `chaos-target` returning after a fixed delay, p95 latency at 40 checks per tick is within 200 ms of p95 at 1 check per tick | Compare the two runs from tick logs |
| P5 | Write budget holds | ≤ 2.5 rows written per check, averaged over the soak | D1 dashboard rows written ÷ checks run |
| P6 | Overlapping ticks are safe | Force a tick that runs longer than 60 s; 0 monitors checked twice in one interval | `check_events` / tick logs |
| P7 | Same-origin session works | The React page served by the Worker gets an `HttpOnly; Secure; SameSite=Lax` cookie from `/api/v1/...` and sends it back on the next call | Browser dev tools |
| P8 | Requests stay small | Worker requests per day during the soak ≤ 10% of 100,000 | Workers dashboard |

P1 allows about 14 failed ticks. P4 is the test for the 6-connection queueing problem (CLAUDE.md §5): if it fails, the latency timer starts too early.

## 4. Build steps

One branch and one PR per step (CLAUDE.md §12). CI must be green before merging. Code that survives into the product (scaffold, CI, checker, chaos-target) is written properly with tests; spike-only bits (burst switches, the cookie test route) are clearly marked and removed after Phase 0.

- [x] **Step 1: `chore/scaffold`**
  - [x] npm workspaces (`apps/*`, `packages/*`): `apps/app` and `packages/core`. `apps/chaos-target` is created in step 3, where it gets real code. Cloudflare's scaffolder (create-cloudflare 2.74.0) ignored `--template` when run non-interactively and its install failed, so `apps/app` was written by hand from the files it generated (`hello-world-with-assets`), with versions taken from npm on 2026-10-19.
  - [x] TypeScript `strict` (pinned `~6.0`: typescript-eslint 8.71 supports `<6.1`, so TypeScript 7 waits), ESLint 10 flat config, Prettier, Vitest 5. `packages/core` has `worstState` (project health, CLAUDE.md §3) with tests; `apps/app` has `GET /api/v1/health` tested in workerd.
  - [x] Add `.gitattributes` with `* text=auto eol=lf`. This machine has `core.autocrlf=true`, which checks files out with CRLF, and Prettier's LF default would then fail `--check` locally.
  - [x] `npm run typecheck && npm run lint && npm test` pass locally (2026-10-19). `wrangler deploy --dry-run` bundles the Worker.
- [x] **Step 2: `ci/build`**
  - [x] `.github/workflows/ci.yml`: runs on `pull_request` and on `push` to `main`; `actions/setup-node` with Node 22 and the npm cache; `npm ci`, typecheck, lint, test, build; `permissions: contents: read`. First green run 2026-10-19 (PR #4 and `main`).
  - [ ] After the first green run, protect `main`: require the CI checks (`typecheck, lint, test, build` and, from step 3, `chaos-target Docker image`), block force-pushes.
- [x] **Step 3: `feat/chaos-target`**
  - [x] Node + Hono service (`apps/chaos-target`), run by Node's type stripping with no build step: `/ping` (always 200, the Render health check), `/delay/:ms` (≤ 30 s), `/status/:code` (200-599), `/scheduled` (a 2-hour cycle anchored to the epoch: UP 60, DOWN 20, UP 10, SLOW 15 at 3 s, UP 5, FLAPPING 10 min), and `/schedule` (ground truth: phase windows for a range, plus `bootedAt` so Render restarts can be told apart from planned outages).
  - [x] Unit tests for the schedule logic and every route (fake clock, no real waiting).
  - [x] `Dockerfile` (repo root as context, only this workspace's production dependencies), `.dockerignore`, `render.yaml` Blueprint, and a CI job that builds the image and smoke-tests it.
  - [x] Deployed to Render free from the Blueprint on 2026-10-21 (no card asked): **https://uptime-chaos-target.onrender.com**. Every route checked from outside. It stays awake as long as it is checked more often than every 15 minutes. After it has slept, the first checks time out while it wakes (seen locally on 2026-10-21: three 10 s timeouts), so a Render restart looks like an outage. `bootedAt` in `/schedule` tells the two apart.
- [x] **Step 4: `feat/checker-cron`**
  - [x] D1 migration `apps/app/migrations/0001_checker.sql`: `monitors`, `check_rollups_hourly`, `check_events`, `usage_daily`. Only primary keys, no other index. There is no `lease_until` column: the claim moves `next_run_at` one interval ahead, and that is the lease. `check_rollups_hourly` and `usage_daily` are `WITHOUT ROWID`. Local D1 accepts it; confirm on remote D1 in step 6. If remote rejects it, use a normal table and expect one extra row written per monitor per hour.
  - [x] `scheduled()` handler (`apps/app/src/checker/`): one `UPDATE … RETURNING` claims due monitors, using the cron's scheduled time so the next run lands on an exact cron minute; checks run at most 6 at a time, each timer starting when its own request starts; the state machine (`applyCheck` in `packages/core`) decides what changed; one `db.batch()` writes rollups, changed monitor rows and events for failures and state changes; one usage upsert; one log object per tick with claims, failures, transitions, statement count, rows written per statement kind (from D1's own `meta`), rows read and latency p50/p95/max.
  - [x] Switches (vars in `wrangler.jsonc`): `MAX_CHECKS_PER_TICK` (1 to 40, default 40) for the P4 baseline; `SPIKE_SLOW_TICK_MS` (spike only, remove after Phase 0) for P6.
  - [x] Tests in workerd against the real migration: claim takes only due, enabled monitors and won't hand one out twice; limit and ordering; rollup upsert accumulates within an hour; DOWN after 3 failures; recovery event; slow vs failed; an overlapping tick checks nothing twice (P6); concurrency never above 6 and queueing doesn't inflate latency (P4). Outbound `fetch` is injected and faked.
  - [x] Local run against the live chaos-target with `wrangler dev --test-scheduled`. Local D1 reports 2 rows written per healthy check (claim 1, rollup 1) and 4 per failure (plus monitor row and event). Local accounting may differ from production; P5 decides.
- [x] **Step 5: `spike/same-origin`**
  - [x] Minimal React 19 + Vite 8 page in `apps/app/web/`, built into `apps/app/dist/client` and served by the Worker as static assets (`assets` in `wrangler.jsonc`: SPA fallback for unknown paths, `run_worker_first` for `/api/*` so an API 404 never turns into `index.html`). Plain Vite, not `@cloudflare/vite-plugin`: production is identical (one Worker, one origin), and the plugin mostly changes the dev setup; revisit when the real frontend starts.
  - [x] Spike routes (`apps/app/src/spike/cookie.ts`, remove after Phase 0): `POST /api/v1/spike/cookie` sets `__Host-spike_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`, 10 minutes), `GET` reports `{ received }` without echoing the value, `DELETE` clears it. Tests check the attributes and the round trip; checked locally on `wrangler dev` with curl on 2026-10-21. The browser half of P7 is step 7, on the deployed `*.workers.dev` URL (real HTTPS).
- [ ] **Step 6: Deploy** (the `database_id` change needs a small branch, e.g. `chore/deploy`; everything else is commands)
  - [ ] `wrangler d1 create uptime` and put its `database_id` in `apps/app/wrangler.jsonc`; `wrangler d1 migrations apply uptime --remote` (this is where remote D1 confirms or rejects `WITHOUT ROWID`); `wrangler secret put` for any secret; `npm run deploy -w apps/app` (builds the React page, then `wrangler deploy`).
  - [ ] Seed 40 monitors pointing at `chaos-target` routes.
- [ ] **Step 7: Run the tests**
  - [ ] P7 in a browser. P6 with the slow-tick switch.
  - [ ] Burst: 1 hour at 40 checks per tick, plus 10 minutes at 1 check per tick for the P4 baseline (P2, P3, P4).
  - [ ] Soak: 24 hours at 10 checks per tick (P1, P5, P8).
- [ ] **Step 8: Probes** (not pass criteria; they settle open items cheaply)
  - [ ] **SSRF facts:** what does a Worker's `fetch()` do with `http://127.0.0.1/`, `http://10.0.0.1/`, `http://169.254.169.254/`, `http://[::1]/`? Record the exact result for the README.
  - [ ] **`db.batch()`:** does a batch of 60 statements hit the 50-queries-per-invocation limit?
  - [ ] **Index write cost:** on a scratch table, compare D1's rows-written for an `UPDATE` of an indexed column versus an unindexed one, so the per-check figure is understood rather than assumed.
  - [ ] **Email:** one send through a provider's HTTP API to your own address from the Worker. Record the provider, whether signup needed a card, and the free daily cap.
  - [ ] **GitHub OAuth:** does GitHub support PKCE for OAuth Apps today? (Read GitHub's docs.)
  - [ ] **Dead man's switch:** find a heartbeat-monitoring service with a card-free free tier (CLAUDE.md §11).

## 5. If something fails

1. Reduce work per tick: fewer checks per tick (spread monitors across ticks), fewer queries (bigger batches), fewer rows (more aggregation).
2. Rethink the write model (for example rollups per 6 hours, or raw events kept only for incidents).
3. Fall back to Option A (CLAUDE.md §9).

Write down which criterion failed and what you tried.

## 6. Results (fill in)

| # | Threshold | Measured | Pass? | Notes |
|---|---|---|---|---|
| P1 | ≥ 1,426 of 1,440 ticks | | | |
| P2 | 0 CPU errors; p99 ≤ 7 ms at 40 checks | | | |
| P3 | 0 subrequest / query-limit errors | | | |
| P4 | p95 gap ≤ 200 ms (40 vs 1 check) | | | |
| P5 | ≤ 2.5 rows written per check | | | |
| P6 | 0 double checks | | | |
| P7 | Cookie round-trips | | | |
| P8 | ≤ 10,000 requests/day | | | |

- `db.batch()` counts as:
- `fetch()` to private / loopback addresses:
- Email provider, card needed?, daily cap:
- GitHub PKCE for OAuth Apps:
- Dead man's switch service:

**Decision:** ☐ Option B confirmed ☐ Work per tick reduced, re-run ☐ Write model changed, re-run ☐ Fall back to Option A

Record the decision and the evidence in DECISIONS.md.
