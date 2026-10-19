# CLAUDE.md — Application Health Monitoring Platform

Read this first every session. Options considered and the reasoning behind decisions are in `DECISIONS.md` (read it before proposing alternatives to anything decided here).

## 1. What this is
A platform that monitors deployed applications (synthetic / black-box monitoring: we probe from outside) and alerts developers when a service goes down or gets slow.

**Purpose:** portfolio project for a final-year ICT student targeting junior to early-mid backend roles (Java or TypeScript; the developer's Java work lives in other projects). It must demonstrate backend engineering, scheduling, API design, security awareness, testing, and deployment. It does NOT try to beat UptimeRobot; the README must say so.

**Hard constraints:**
- NO payment card that cloud providers accept. Everything must run on card-free free tiers. Never suggest a service that requires a card unless it is clearly labelled optional.
- NO custom domain. We use the host's default domains (`*.workers.dev`, `*.onrender.com`). Consequence: email can only reach the account owner's own address (see section 7).

**Differentiator:** a `chaos-target` service that goes down, slows down, and flaps on a schedule. We measure the platform against it: time-to-detect, false-alert rate, missed-incident rate.

## 2. Current status
Pre-code. **Phase 0 (spike) comes before any feature work.** See section 4 and the working checklist in `docs/phase-0-checklist.md`.

## 3. Decisions made (do not relitigate without a reason; see DECISIONS.md)
**Chosen: Option B — Cloudflare-native TypeScript** (switched from Option A on 2026-10-19; reasons in DECISIONS.md §10).
**Fallback: Option A — Spring Boot on Render + Aiven MySQL**, only if the Phase 0 spike shows B cannot work.

| Area | Decision |
|---|---|
| Runtime | Cloudflare Workers, TypeScript (`strict`), Hono for routing. Node 22 and Wrangler locally |
| App shape | One `app` Worker: `fetch` handler serves the API under `/api/v1` and the React build via Workers Static Assets (same origin, so first-party cookies and no CORS); `scheduled` handler runs the checker on a Cron Trigger every minute |
| Database | D1 (SQLite). Migrations with `wrangler d1 migrations` |
| Frontend | React + TypeScript (Vite), served by the `app` Worker as static assets. Not Cloudflare Pages (would be a different site from the API) |
| chaos-target | Small HTTP service on **Render free** (Docker). It must be outside our Cloudflare account: a Worker cannot reliably `fetch()` another Worker on the same account by URL, and a service binding would skip the real network |
| Auth | GitHub OAuth (authorization code flow with `state` and PKCE where GitHub supports it; verify). Sessions: random token in an `HttpOnly; Secure; SameSite=Lax` cookie, only its SHA-256 hash stored. No passwords. API keys for programmatic access |
| Alerts | Discord webhooks (primary) and email via a provider's HTTP API (owner-only, no domain). Team-level channels plus per-user subscriptions, with per-project and per-monitor rules |
| Structure | Team → Project → Monitors (endpoints). Project health = worst-of its monitors |
| Validation | Zod schemas at the API boundary; OpenAPI generated from them (`@hono/zod-openapi`; verify current package) |
| Tests | Vitest. Pure domain tests in plain Node; Worker and D1 tests with `@cloudflare/vitest-plugin` (runs in the Workers runtime; formerly `@cloudflare/vitest-pool-workers`, renamed and deprecated). Mock outbound `fetch` the way that package currently recommends (verify) |
| Repo layout | npm workspaces: `apps/app` (Worker + React), `apps/chaos-target`, `packages/core` (pure domain), `contract-tests/*.json` |

**Not in scope / rejected:** Kafka, Kubernetes, microservices, AI features, SMS, WhatsApp, Telegram (see DECISIONS.md), Azure and Oracle (card required), Cloudflare Pages for the frontend (cross-site cookies), SMTP (blocked on Render free; port 25 blocked for Workers sockets; no domain anyway).

## 4. Phase 0 — spike (time-box about two evenings plus a 1-hour burst and a 24-hour soak)
Deploy a skeleton `app` Worker with a cron, D1, and a `chaos-target` on Render. Prove the free-plan limits fit before building features. Pass criteria and steps: `docs/phase-0-checklist.md`.

**If it fails:** first reduce work per tick (fewer checks, fewer queries, fewer rows), then reconsider the write model (section 5), then fall back to Option A. Do not sink more than the time-box into rescuing B.

## 5. Architecture
```
Cron Trigger (every minute)
   → app Worker: scheduled()
      → claim due monitors (conditional UPDATE sets a lease; overlapping runs skip leased rows)
      → run checks with fetch() (concurrency ≤ 6, per-check timeout, overall time budget)
      → one db.batch(): results, monitor state, incidents, alert_events (outbox)
      → deliver pending alert_events (bounded per run, retries with backoff)
Browser → app Worker: fetch()
      → /api/v1/*   Hono + Zod, session cookie or API key
      → everything else: React static assets (free, unlimited)
Render free → chaos-target (a fixture we monitor like any external site)
```
**Free-plan limits that shape the design** (checked 2026-10-15/19; re-verify at build time):
- Workers: 100,000 requests/day; **10 ms CPU** per invocation (waiting on `fetch()` is not CPU); **50 subrequests** per invocation; **6 connections** waiting for response headers at once; cron wall time 15 min; 5 cron triggers per account. Static asset requests are free and unlimited.
- D1: **100,000 rows written/day** (`INSERT`, `UPDATE` and `DELETE` all count), 5 million rows read/day, **50 queries per invocation**, 500 MB per database, 5 GB per account. When a daily limit is hit, **all queries fail until 00:00 UTC**.

**Design rules that follow:**
- **Checks per tick:** at most about 40 (subrequest budget, minus alert calls). Cap concurrency at 6 ourselves and start the latency timer when the request actually starts, otherwise queueing inflates latency and causes false SLOW alerts.
- **Queries per tick:** use `db.batch()`. Whether a batch counts as one query or many toward the 50 is unverified; the spike measures it.
- **Write budget is the binding limit.** Target ≤ 2 rows written per check in the steady state: the claim `UPDATE` (advances `next_run_at` and sets `lease_until` in one statement, so it doubles as the lease) and one hourly rollup upsert (count, failures, latency histogram buckets). The monitor row is rewritten again only when state or counters change; raw check rows are stored only for failures and state changes. Deletes cost writes too, so retention removes rollups and raw failure rows, never per-check rows.
- **Indexes cost writes.** D1 adds at least one row written whenever a write touches an indexed column (fact, D1 pricing docs). So:
  - **No index on `next_run_at` or `lease_until`.** The claim changes both on every check; an index would make it 3+ rows per check. The claim scans the `monitors` table instead, which costs reads: 100 monitors × 1,440 ticks = 144,000 rows read/day (3% of the 5M cap). Revisit at about 1,000 monitors (about 29%).
  - **`check_rollups_hourly` has `PRIMARY KEY (monitor_id, hour)` and is `WITHOUT ROWID`**, so the key is the table and there is no separate index to write (inference from SQLite; verify D1 supports `WITHOUT ROWID`). An upsert into an existing hour then writes exactly one row.
  - **Counters must not change in a steady state.** `consecutive_failures` stays 0 while UP; `consecutive_successes` is counted only while DOWN. Otherwise the monitor row is rewritten on every check.
- **Estimate:** at 2 rows/check, 100 monitors at 5-minute intervals write 100 × 288 × 2 = 57,600 rows/day, plus 1,440 for the per-tick `usage_daily` counter: about 59% of the cap. If one extra index row slips in (3 rows/check) it is about 88%, past the 80% guard below, so P5 in the spike is what proves the model. The old estimate (4 rows/check, "about 100 monitors") was wrong: 4 rows/check caps out at about 85 monitors.
- **Daily-cap safety:** track rows written per day in a counter; above 80% of the cap, stretch intervals and alert the owner once, so the dashboard never hard-stops.
- **Min monitor interval:** default 5 minutes; per-team monitor cap.
- **Alerts use an outbox table.** A Discord or email failure must never lose or block an alert or a check.
- **Timestamps:** UTC everywhere, stored as INTEGER epoch milliseconds.
- **Uptime %:** successful checks / total checks in the window, computed from rollups. Document it in the README.

## 6. Monitor state machine (pure TypeScript in `packages/core`, no Workers or Hono imports)
States: `UP`, `DEGRADED` (slow), `DOWN`.
- UP → DEGRADED: latency above the monitor's threshold for N consecutive checks.
- UP/DEGRADED → DOWN: N consecutive failures (default N=3, configurable).
- DOWN → UP: M consecutive successes (default M=2).
- Opening DOWN creates an `incident`; recovery closes it. One alert on open, one on recovery, none while unchanged. A single timeout never alerts.
A check "fails" on: timeout, connection error, status code not matching expected, or (optional) expected text missing.
Test vectors live in `contract-tests/*.json` so a future port (for example back to Java) must pass the same cases.

## 7. Alerts, rules, and channels
**Tables:** `notification_channels` (team-owned: type `EMAIL|DISCORD`, config encrypted, `verified_at`, enabled), `alert_rules` (scope `PROJECT|MONITOR`, scope_id, event_type `DOWN|RECOVERED|SLOW`, target_type `CHANNEL|USER`, target_id, enabled, cooldown_minutes), `alert_events` (outbox), `alert_deliveries` (event, target, status, attempts, last_error).
- **Resolution order:** monitor rule overrides project rule overrides team default.
- **Defaults:** every new project gets DOWN and RECOVERED to the team's Discord channel if one exists. Warn if a change leaves a project with no active alerts.
- **Build order:** team-level channels and rules first, then per-user subscriptions layered on the same rule table.
- **Discord (primary):** user pastes a webhook URL. Treat it as a secret (encrypt, show last few characters only). Accept only Discord's own host and the `/api/webhooks/{id}/{token}` shape (this also removes SSRF risk). Send a test message on save. 404 = mark channel broken and tell the user; 429 = retry after the indicated delay. Limit is roughly 5 requests per 2 seconds per webhook.
- **Email (limited):** sent through a provider's HTTP API behind an `EmailSender` interface (provider = config plus one adapter). Without a domain, providers only deliver to the account owner's own address (Resend's testing mode, per third-party sources; verify), so email is an owner-only channel and the UI says so. Free daily caps are small (indicative 100-300/day; verify): de-duplicate, apply cooldowns and a daily cap. If a domain is ever added, email to all users becomes a config change.
- **Delivery isolation:** one channel failing must not block the others. Show failed deliveries in the UI.

## 8. Security rules (non-negotiable)
**SSRF (the checker fetches user-supplied URLs).** Workers cannot pin the resolved IP, so we validate as much as the platform allows and document the gap honestly:
1. Allow only `http` and `https`. Parse with the WHATWG `URL` parser (it normalises odd IPv4 forms like `http://2130706433/`).
2. Reject IP literals in loopback, private (RFC 1918), link-local, CGNAT, cloud-metadata ranges, and IPv6 equivalents (including IPv4-mapped IPv6). Reject `localhost`, `*.localhost` and other internal-only names.
3. Resolve the hostname with DNS-over-HTTPS when a monitor is created or its URL changes, and periodically after; reject if any answer is in a blocked range. This is a check, not a pin: DNS rebinding remains a documented, accepted gap.
4. `redirect: 'manual'`; re-validate every `Location`; cap redirects. Per-check timeout via `AbortSignal`, cap bytes read, never return response bodies to users.
5. One unit test per blocked category. Never weaken these for convenience.
6. The spike records what Workers' `fetch()` actually does with private and loopback addresses, so the README states it as fact, not assumption.

**Auth and secrets**
- GitHub OAuth: `state` always, PKCE where supported (verify); separate OAuth Apps for dev and prod; scopes `read:user user:email`.
- Key users by GitHub's immutable numeric user ID, not email. Never auto-link accounts by unverified email.
- Sessions and API keys: 32 random bytes from `crypto.getRandomValues`, base64url; store only a SHA-256 hash (Web Crypto); API keys shown once, with a short plain prefix for lookup. Constant-time comparison where secrets are compared.
- Encrypt channel configs and secrets at rest with AES-GCM (Web Crypto); the key is a Worker secret. Never log tokens, keys, webhook URLs, or secrets.
- Secrets via `wrangler secret put` and GitHub encrypted secrets only; never in the Wrangler config file or the repo.
- Every query is scoped to the caller's team. Test cross-team access explicitly (user A must never read team B).
- Rate-limit monitor creation and auth endpoints. Validate all input with Zod.
- Personal data (emails) is minimal and deletable (POPIA). The demo uses seeded or synthetic data.
- **Demo mode:** a "try demo" path with seeded read-only data, so recruiters need not authorize GitHub.
- **No passwords, ever:** secure password hashing does not fit the 10 ms CPU budget. OAuth only.

**Abuse:** the platform makes requests to third-party sites. Enforce a minimum interval, a per-team monitor cap, and a clear `User-Agent` (`HealthMonitor/1.0`). Ownership verification of monitored URLs is a documented stretch.

## 9. Fallback plan: Option A (Spring Boot on Render + Aiven MySQL)
Switch back only if the Phase 0 spike shows B cannot meet its pass criteria after the fixes in section 4. The full Option A plan and its Phase 0 checklist are in git history (commit `d1c9c73`) and DECISIONS.md. Findings that would apply on return: Render free blocks outbound SMTP; 750 free hours are per workspace (and `chaos-target` already uses them); Spring Boot 3.x is out of OSS support, so use 4.1.x. The pure domain and `contract-tests/*.json` make the port cheaper.

## 10. Data model (starting point; refine)
`users`(github_id, ...), `sessions`(token_hash, user_id, expires_at), `teams`, `team_members(role)`, `projects(team_id, deleted_at)`, `monitors(project_id, url, interval_seconds, timeout_ms, latency_threshold_ms, expected_status, expected_text, state, consecutive_failures, consecutive_slow, consecutive_successes, last_checked_at, next_run_at, lease_until, dns_checked_at)`, `check_events(monitor_id, checked_at, success, status_code, response_ms, error)` (failures and state changes only), `check_rollups_hourly(monitor_id, hour, total, failures, latency buckets...)`, `incidents(monitor_id, started_at, resolved_at)`, `notification_channels`, `alert_rules`, `alert_events`, `alert_deliveries`, `api_keys(prefix, hash, team_id, last_used_at, revoked_at)`, `usage_daily(day, rows_written)`. Every index costs a row written when its columns change (section 5), so add indexes only on columns that rarely change: none on `monitors(next_run_at)` or `lease_until`; `check_rollups_hourly` is `WITHOUT ROWID` with `PRIMARY KEY (monitor_id, hour)`. Soft-delete projects; purge after a retention period.

## 11. Observability of the platform itself
Structured JSON logs (`console.log` of one object per event) with a correlation id per tick and per check; Workers Logs and the Workers/D1 dashboards for CPU time, invocations, and rows written. A `GET /api/v1/health` endpoint. Each tick records its stats (duration, checks run, failures, alerts sent, rows written) in the logs and the `usage_daily` counter. **Dead man's switch:** the cron cannot report that it stopped running, so an outside free service should watch for missing ticks (candidate: a heartbeat-monitoring service with a card-free free tier; verify before choosing). A monitoring tool must be monitorable.

## 12. Conventions
TypeScript `strict`, no `any` without a comment explaining why. Feature folders. Dependencies passed in explicitly (no hidden globals), so domain code is testable without the Workers runtime. DTOs at the API boundary (never return database rows directly). Consistent error format. API under `/api/v1`, documented with OpenAPI. ESLint and Prettier. Small commits with conventional messages (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`), made by the developer (see Git below). Every feature ships with tests: unit tests for the pure domain, `@cloudflare/vitest-plugin` tests for scheduler and D1 logic, mocked `fetch` for the checker.

**Git (always, no exceptions):**
- **The developer does all git operations** (staging, committing, pushing, opening and merging PRs), mostly through the VS Code Git extension. Claude edits files only: never run `git add`, `git commit`, `git push` or anything that rewrites history. When a change is ready, say what changed and suggest a commit message; give git commands only where VS Code can't easily do the job.
- **No AI attribution:** commit messages and PR descriptions never include `Co-Authored-By: Claude`, session links, or "Generated with Claude Code".
- Never commit to `main`. Before suggesting a commit, check the current branch; if it is `main`, tell the developer to create a branch first.
- One branch per change, with a short generic name by type: `feat/`, `fix/`, `test/`, `docs/`, `chore/`, `ci/`, `spike/` (e.g. `docs/updates`, `chore/scaffold`).
- Changes reach `main` only through a pull request with green CI. Protect `main`: require the CI check, block force-pushes. The repo is public, so branch protection is available on GitHub Free (verify the setting when enabling it).

**CI and workflows (always):**
- GitHub Actions in `.github/workflows/`. `ci.yml` runs on every pull request and every push to `main`: `npm ci`, typecheck, lint, test, and build for every workspace. Add a job in the same PR that creates a new workspace.
- A change that adds a workspace, build step, deployable, binding, or environment variable updates the workflows (and the README's config list) in the same PR. A feature is not done until CI is green.
- Workflow hygiene: least-privilege `permissions:`, secrets only from GitHub encrypted secrets and never echoed, GitHub-owned actions pinned to a major tag, third-party actions pinned to a full commit SHA.
- Deploy workflows (`wrangler deploy` and D1 migrations with a scoped Cloudflare API token; Render deploy for `chaos-target`) are added when a phase needs them, not before, and run only from `main`.

## 13. Commands
```
npm ci
npm run typecheck && npm run lint && npm test
npm run format                           # Prettier --write; `lint` runs Prettier --check
npm run dev -w apps/app                  # wrangler dev: Worker + local D1 + static assets
npm run cf-typegen -w apps/app           # regenerate worker-configuration.d.ts after editing wrangler.jsonc
npx wrangler d1 migrations apply <db> --local
npm run dev -w apps/chaos-target         # from step 3
```
`worker-configuration.d.ts` is generated (gitignored); `npm run typecheck` regenerates it.
Develop locally with `wrangler dev` first. Hosting is only needed for Phase 0 and the final deploy.

## 14. Stretch (only after the MVP works)
- **Events API:** the monitored app calls `POST /api/v1/events` with an API key so users can alert when an endpoint is actually called. Polling cannot detect real traffic. This is the answer to "alert when an endpoint is triggered".
- Heartbeat (push) monitors, SSL certificate expiry alerts, public status page, ownership verification of monitored URLs, Telegram, email to all users (needs a domain).

## 15. How to work with me (the developer)
I am a student learning to think like an engineer.
- Explain WHY, and state the trade-off when you pick an approach. Challenge my requests if they are wrong, risky, or overengineered. Do not just agree.
- Do not invent APIs, library features, config properties, or versions. If unsure, say so and tell me what to verify (official docs, the version in `package.json`).
- Label fact versus inference versus recommendation. State assumptions explicitly. Ask a question only when the answer would change the design materially.
- Keep diffs small and reviewable. Tell me how to test and verify each change.
- Free-tier limits and prices change. Anything marked "verify" must be checked against the provider's current docs before relying on it.
