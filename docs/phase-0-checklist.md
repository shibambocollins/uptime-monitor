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
- [x] **Step 6: Deploy** (2026-10-21, branch `chore/deploy` for the `database_id` and the seed file)
  - [x] `wrangler d1 create uptime` (region WEUR) and its `database_id` in `apps/app/wrangler.jsonc`; `wrangler d1 migrations apply uptime --remote`; no secrets needed yet; `npm run deploy -w apps/app`. Live at **https://uptime-app.uptime-app.workers.dev** (Wrangler registered the `uptime-app` workers.dev subdomain on the first deploy). Checked from outside: `/api/v1/health` 200, `/` serves the React page, `/api/v1/nope` is a Worker 404 (not `index.html`), and the spike cookie round-trips over HTTPS with curl.
  - [x] **Remote D1 accepts `WITHOUT ROWID`:** `sqlite_master` shows `check_rollups_hourly` and `usage_daily` as `WITHOUT ROWID`, and none of our tables has an index (only D1's own `d1_migrations` does).
  - [x] Seeded 40 monitors with `apps/app/scripts/phase0-seed.sql`, all **disabled** (40 enabled at 60 s would hit the write cap in under a day): 1-20 `/delay/500` (P4), 21-30 `/scheduled`, 31-40 `/ping`. D1 reported 40 rows written for the 40 inserts, so a plain insert into `monitors` costs exactly one row.
  - [x] **Cron timing (fact, observed):** ticks run every minute, but not on the minute: every `scheduledTime` was at :45.457, and the handler started 1.1-2.0 s after it. An idle tick used 1-3 ms CPU and about 0.5 s wall time (mostly the two D1 round trips). New cron triggers took a few minutes to start firing after the first deploy.
- [ ] **Step 7: Run the tests** (2026-10-21; results in section 6)
  - [x] P7 in a browser on the deployed URL (you, 2026-10-21): `received: true`, cookie flags correct.
  - [x] P6: deployed once with `--var SPIKE_SLOW_TICK_MS:70000` and 5 monitors at 300 s. The 17:49:45 tick claimed them and ran 80.7 s; the next three ticks started while it was still running and each claimed 0.
  - [x] P4: two 11-minute runs against `/delay/500` only, because the tick log has per-tick latency (p50/p95/max), not per-check: all 40 monitors, then monitor 1 alone.
  - [x] Burst: the seeded mix, 40 checks per tick, 18:18-19:09 UTC (51 of the planned 63 minutes: Claude Code stopped the local job driving it because the PC was low on memory, so the final "disable everything" step was run by hand). D1 recorded every tick, including chaos-target's DOWN window from 19:00. `wrangler tail` dropped 16 of 53 tick events under load, so counts come from D1, not the tail.
  - [x] First soak, 10 checks per tick, monitors 21-25 (`/scheduled`) and 31-35 (`/ping`), from 2026-10-21 19:12:11 UTC. **Stopped by mistake at 22:20:48 UTC:** the burst's local job had not actually been stopped (the notification said it was), and its last step disabled monitors 1-40, including these 10. Up to then: 1,890 checks, 2.21 rows per check. The cron itself kept running: 1,062 of 1,062 ticks by 2026-10-22 12:54 UTC, with nothing to check after 22:20.
  - [ ] Soak of the fan-out checker (step 9): 24 hours, 20 monitors (IDs 101-120, `apps/app/scripts/phase0-soak.sql`), 20 checks per tick in 2 groups (P1, P5, P8).
- [ ] **Step 8: Probes** (on a throwaway Worker, `uptime-probe`, with its own scratch D1, 2026-10-21; delete both after Phase 0)
  - [x] **SSRF facts:** section 6.
  - [x] **`db.batch()`:** batches of 60 statements succeeded in the burst (40 rollups + 10 monitor updates + 10 events, 19:00-19:02).
  - [x] **Index write cost:** for 10 rows, an insert writes 10 rows without an index and 20 with one; an `UPDATE` of an indexed column 20, of an unindexed column on the same table 10; a `DELETE` 10 either way.
  - [ ] **Email:** postponed until alerting is built (you, 2026-10-21). Resend's pricing page lists 100 emails/day and 3,000/month on the free plan; whether signup needs a card and whether you can send without a domain are still unverified.
  - [x] **GitHub OAuth:** PKCE is supported for OAuth Apps: `code_challenge` with `code_challenge_method=S256` (`plain` is not supported) and `code_verifier` on the token request, all marked "Strongly recommended" (GitHub docs, "Authorizing OAuth apps", read 2026-10-21).
  - [x] **Dead man's switch:** Healthchecks.io Hobbyist: free, 20 checks, signup with an email address and a magic link, no card mentioned on the pricing page (read 2026-10-21; confirm at signup).
  - [x] **CPU profile** (added after P2 failed): section 6.
  - [x] **Fan-out** (added after P2 failed): section 6.
- [ ] **Step 9: `feat/checker-fanout`** (CLAUDE.md §4: reduce work per tick)
  - [x] `CheckRunner` (`apps/app/src/checker/runner.ts`), a `WorkerEntrypoint` that runs one group of checks. The tick calls it through `ctx.exports` for each group of 10, one group at a time (the 6-connection limit is shared by the chain). `ctx.exports` needs no flag from compatibility date 2025-11-17.
  - [x] Tick deadline: a group only starts if it would finish within 50 s of the tick start even if every check timed out; the first group always runs. Claimed monitors that were not checked (deadline or a failed runner) are released (`next_run_at` back to the tick time), so the next tick takes them. This also closes the lease gap for 60 s monitors.
  - [x] `MAX_CHECKS_PER_TICK` default back to 40 (hard cap 200; the deadline is the real limit).
  - [x] Tests: groups of 10 run one at a time; the deadline stops further groups and releases their monitors; a failed runner releases its group without recording failures; `CheckRunner` through `exports` returns plain results; `scheduled()` end to end through `CheckRunner`.
  - [x] Local run (`wrangler dev`, 2026-10-22): 25 monitors on chaos-target `/ping`, 3 groups, 25 checked, 0 runner errors, tick 1.5 s, p95 344 ms.
  - [ ] Deploy, then a 30-minute burst at 40 checks per tick: re-check P2 (CPU per invocation) and P4 on the real cron.
  - [ ] Then the 24-hour soak above.

## 5. If something fails

1. Reduce work per tick: fewer checks per tick (spread monitors across ticks), fewer queries (bigger batches), fewer rows (more aggregation).
2. Rethink the write model (for example rollups per 6 hours, or raw events kept only for incidents).
3. Fall back to Option A (CLAUDE.md §9).

Write down which criterion failed and what you tried.

## 6. Results

| # | Threshold | Measured | Pass? | Notes |
|---|---|---|---|---|
| P1 | ≥ 1,426 of 1,440 ticks | soak running | | 186 of 186 ticks in the first 3 hours |
| P2 | 0 CPU errors; p99 ≤ 7 ms at 40 checks | 0 CPU errors, but **p99 29 ms** (median 18) at 40 checks; 4-7 ms at 1 check; 1-3 ms idle | **Fail** | Every 40-check tick ran 2-3× over the 10 ms limit and Cloudflare stopped none. Its docs only promise tolerance for "infrequent" overruns, so this is not safe to rely on. See "CPU" below. |
| P3 | 0 subrequest / query-limit errors | 0 errors in about 60 ticks of 40 checks, including 60-statement batches | Pass, one part untested | The "+1 Discord call" is not tested: alerting is not built yet |
| P4 | p95 gap ≤ 200 ms (40 vs 1 check) | 40 per tick: median of per-tick p95 **1,073 ms** (p50 698); 1 per tick: p95 **1,335 ms** (p50 795) | Pass | 40 at once was not slower: the concurrency cap and per-request timer work |
| P5 | ≤ 2.5 rows written per check | burst 2.009; 40-check runs exactly 2.000; soak 2.22 after 3 h | soak running | Healthy checks cost exactly 2 rows on real D1 |
| P6 | 0 double checks | 0 | Pass | Holds only while a monitor's interval is longer than the tick (see "Lease") |
| P7 | Cookie round-trips | `received: true`, `HttpOnly; Secure; SameSite=Lax`, `__Host-` prefix | Pass | Browser, deployed HTTPS URL |
| P8 | ≤ 10,000 requests/day | soak running | | Cron ticks are 1,440/day; fan-out calls are not counted as requests (Cloudflare pricing docs) |

**Other measurements (facts, 2026-10-21):**
- **Time to detect:** chaos-target went DOWN at 19:00:00; the `/scheduled` monitors reached DOWN at 19:02:46 (60 s interval, 3 failures needed).
- **False alerts:** 1 failed check in about 2,500 during the burst (a 502 from Render's proxy); the 3-failure rule absorbed it, no state change.
- **Render sleep:** after 15 minutes without traffic, the first checks time out (5 of 5 in the P6 run). A sleeping chaos-target looks like an outage; `bootedAt` tells them apart.
- **Lease:** a monitor whose interval is shorter than a tick is claimed again before the first tick writes its state. 40 checks that all time out can take about 70 s, so a per-tick time budget under the minimum interval is needed before 60 s monitors are allowed.

**CPU** (probe Worker, warm HTTP invocations; cron ticks measured about 2× higher for the same work):
- D1 is close to free: one query, or a batch of 40 statements, 0-1 ms.
- `fetch()` is the cost: 40 checks 8-19 ms, about 0.25-0.45 ms each. Plain `http` costs the same as `https`, so it is not the TLS handshake. Nothing in our code can remove it.
- So one invocation fits about 10 checks with headroom.

**Fan-out** (probe Worker: a `WorkerEntrypoint` called through `ctx.exports`; the probe set the `enable_ctx_exports` flag, but workerd reports it has been the default since compatibility date 2025-11-17):
- Each call is its own invocation with its own CPU time: 10 checks per call cost 1-3 ms and the caller 0-1 ms, against 10 ms for 40 checks in one invocation.
- The subrequest limit is per invocation: 8 calls × 10 checks (80 `fetch()` calls) ran without errors.
- The 6-connection limit is shared by the whole chain. With calls in parallel, latency to `/delay/500` rose from about 690 to about 2,050 ms (requests waiting inside the runtime count as latency). Called one after another, p50 was 688 ms, the same as a single check.
- Not documented: whether Cloudflare *enforces* the 10 ms per invocation or per chain. The per-invocation CPU readings point to per invocation (inference). Calls through service bindings are not billed as requests (Cloudflare pricing docs).

**Probes:**
- `db.batch()`: a batch of 60 statements is fine (burst, 19:00-19:02).
- `fetch()` to private / loopback addresses (with `global_fetch_strictly_public`): it does not throw. IP literals (`127.0.0.1`, `localhost`, `10.0.0.1`, `192.168.1.1`, `172.16.0.1`, `169.254.169.254`, `100.64.0.1`, `[::1]`, `[::ffff:127.0.0.1]`, `2130706433`, `0.0.0.0`) get **403 "error code: 1003"** from Cloudflare in 0-1 ms. Hostnames that resolve to private addresses (`localtest.me`, `127.0.0.1.nip.io`, `10.0.0.1.nip.io`, `169.254.169.254.nip.io`) get **530 "error code: 1016"**. No request reached a private address.
- Email provider, card needed?, daily cap: postponed (Resend lists 100/day; card and no-domain sending unverified).
- GitHub PKCE for OAuth Apps: supported, S256 only.
- Dead man's switch service: Healthchecks.io Hobbyist (free, 20 checks).

**Decision:** ☐ Option B confirmed ☒ Work per tick reduced, re-run ☐ Write model changed, re-run ☐ Fall back to Option A

Work per tick is reduced in two steps (CLAUDE.md §4, step 1). Now: `MAX_CHECKS_PER_TICK` defaults to 10 (the soak already runs at 10, so its results apply). Next (`feat/checker-fanout`): the tick hands groups of about 10 checks to a `CheckRunner` entrypoint, one call at a time, then a short burst re-checks P2 and P4 on the real cron. Record the final decision and the evidence in DECISIONS.md when Phase 0 closes.
