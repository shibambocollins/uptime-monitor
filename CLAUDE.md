# CLAUDE.md — Application Health Monitoring Platform

Read this first every session. Options considered and the reasoning behind decisions are in `DECISIONS.md` (read it before proposing alternatives to anything decided here).

## 1. What this is
A platform that monitors deployed applications (synthetic / black-box monitoring: we probe from outside) and alerts developers when a service goes down or gets slow.

**Purpose:** portfolio project for a final-year ICT student targeting junior to early-mid Java backend roles. It must demonstrate backend engineering, scheduling, API design, security awareness, testing, and deployment. It does NOT try to beat UptimeRobot; the README must say so.

**Hard constraint:** the developer has NO payment card that cloud providers accept. Everything must run on card-free free tiers. Never suggest a service that requires a card unless it is clearly labelled optional.

**Differentiator:** a `chaos-target` service that goes down, slows down, and flaps on a schedule. We measure the platform against it: time-to-detect, false-alert rate, missed-incident rate.

## 2. Current status
Pre-code. **Phase 0 (deployment spike) comes before any feature work.** See section 4.

## 3. Decisions made (do not relitigate without a reason; see DECISIONS.md)
**Chosen: Option A — Spring Boot on Render + Aiven MySQL, with an external tick trigger.**
**Fallback: Option B — Cloudflare-native TypeScript.** Used only if the Phase 0 spike fails (section 4).

| Area | Decision |
|---|---|
| Backend | Java (assume 21; verify in `pom.xml`), Spring Boot 3.x (verify), Maven (change if Gradle). Feature-based packages |
| Backend hosting | Render free web service (about 512 MB RAM, 0.1 CPU, sleeps after 15 min idle, 30-60 s wake). One combined deployment (`all` profile = API + checker); separate `api` / `worker` profiles still exist in code for local dev |
| Database | Aiven free MySQL (1 GB, TLS, capped connections, may power off if unused). Backup: TiDB Cloud Starter (MySQL-compatible, not identical). Postgres (Neon/Supabase) is an acceptable engine switch if needed |
| Scheduler trigger | A tiny Cloudflare Worker with a Cron Trigger (1-minute minimum) calls `POST /internal/tick`. Internal `@Scheduled` trigger is kept behind a config flag for always-on hosts and local dev |
| Frontend | React + TypeScript on Cloudflare Pages |
| Auth | GitHub OAuth via Spring Security `oauth2Login`. No passwords stored. API keys for programmatic access |
| Alerts | Email + Discord webhooks only (free). Team-level channels plus per-user subscriptions, with per-project and per-monitor rules |
| Structure | Team → Project → Monitors (endpoints). Project health = worst-of its monitors |
| Tests | JUnit 5, Mockito, Testcontainers (MySQL), WireMock |

**Not in scope / rejected:** Kafka, Kubernetes, microservices, AI features, SMS, WhatsApp, Telegram (see DECISIONS.md), Azure and Oracle (card required), Render free Postgres (expires in 30 days).

## 4. Phase 0 — deployment spike (weeks 1-2, time-box about two evenings)
Deploy a hello-world Spring Boot app to Render connected to Aiven MySQL.

**Pass if ALL hold** (thresholds are suggestions; adjust but write them down first):
- Starts on the free instance without running out of memory.
- Connects to Aiven over TLS with a Hikari pool of 2-3.
- A protected `POST /internal/tick` answers correctly after Render has slept and woken.
- Runs about 10 fake checks per tick, every minute, for 24 hours with no restart and no memory growth.

**Starting points to tune (measure, do not trust):** `-Xmx256m -XX:+UseSerialGC`, `spring.main.lazy-initialization=true`, `server.tomcat.threads.max` low, `spring.datasource.hikari.maximum-pool-size=3`, run Flyway migrations in CI or at deploy if startup is too slow, build the image in CI if the Render build runs out of memory (verify Render supports prebuilt images on free).

**If it fails:** try the fixes above, then database switch (TiDB or Neon) if the DB is the problem, then **fall back to Option B** (section 9). Do not sink more than the time-box into rescuing A.

## 5. Architecture
```
Cloudflare Worker (cron, every minute)
   → POST /internal/tick   (secret header)
      → Spring Boot on Render
         → claim due monitors (SELECT ... FOR UPDATE SKIP LOCKED, with a lease)
         → run checks (bounded concurrency, time budget)
         → write results; update monitor state; open/close incidents
         → write alert_events (outbox) in the same transaction
      → async sender delivers to channels with retries
React (Cloudflare Pages) → REST API (/api/v1)
```
- **Tick endpoint:** requires a shared secret header (constant-time compare), rate-limited, idempotent (overlapping ticks are safe because of the lease), never blocks on alert sending.
- **Min monitor interval:** configurable. Default 5 minutes on the free tier; tune after the spike.
- **Alerts use an outbox table.** An email or Discord failure must never lose or block an alert.
- **Timestamps:** UTC (`Instant`) everywhere.
- **Uptime %:** successful checks / total checks in the window. Document it in the README.
- **Retention is mandatory** (1 GB DB): delete raw `check_results` older than a configured window (start at 14-30 days), keep hourly rollups longer, compute p95 from rollups. Index `check_results(monitor_id, checked_at)`. Dashboards read rollups, not raw rows.

## 6. Monitor state machine (keep it pure Java with no Spring dependencies)
States: `UP`, `DEGRADED` (slow), `DOWN`.
- UP → DEGRADED: latency above the monitor's threshold for N consecutive checks.
- UP/DEGRADED → DOWN: N consecutive failures (default N=3, configurable).
- DOWN → UP: M consecutive successes (default M=2).
- Opening DOWN creates an `incident`; recovery closes it. One alert on open, one on recovery, none while unchanged. A single timeout never alerts.
A check "fails" on: timeout, connection error, status code not matching expected, or (optional) expected text missing.

## 7. Alerts, rules, and channels
**Tables:** `notification_channels` (team-owned: type `EMAIL|DISCORD`, config encrypted, `verified_at`, enabled), `alert_rules` (scope `PROJECT|MONITOR`, scope_id, event_type `DOWN|RECOVERED|SLOW`, target_type `CHANNEL|USER`, target_id, enabled, cooldown_minutes), `alert_events` (outbox), `alert_deliveries` (event, target, status, attempts, last_error).
- **Resolution order:** monitor rule overrides project rule overrides team default.
- **Defaults:** every new project gets DOWN and RECOVERED to email. Warn if a change leaves a project with no active alerts.
- **Build order:** team-level channels and rules first (Option A in DECISIONS.md), then per-user subscriptions (Option B) layered on the same rule table.
- **Email:** send via SMTP through `JavaMailSender` so the provider is a config change. Dev: Mailpit. Free-tier daily caps are small (indicative: 100-300 a day; verify), so add de-duplication, cooldowns, and per-team daily caps. Verify an email address before it becomes a channel.
- **Discord:** user pastes a webhook URL. Treat it as a secret (encrypt, show last few characters only). Accept only Discord's own host and the `/api/webhooks/{id}/{token}` shape (this also removes SSRF risk). Send a test message on save. 404 = mark channel broken and tell the user; 429 = retry later. Limit is roughly 5 requests per 2 seconds per webhook.
- **Delivery isolation:** one channel failing must not block the others. Show failed deliveries in the UI.

## 8. Security rules (non-negotiable)
**SSRF (the checker fetches user-supplied URLs):**
1. Allow only `http` and `https`.
2. Resolve DNS ourselves; reject loopback, private (RFC 1918), link-local, CGNAT, cloud-metadata, and IPv6 equivalents (including IPv4-mapped IPv6).
3. Connect to the validated IP (prevents DNS rebinding); re-validate on every redirect.
4. Limit redirects, set connect/read timeouts, cap body size, never return response bodies to users.
5. One unit test per blocked category. Never weaken these for convenience.

**Auth and secrets**
- GitHub OAuth: use the `state` parameter and PKCE where supported; separate OAuth Apps for dev and prod; scopes `read:user user:email`.
- Key users by GitHub's immutable numeric user ID, not email. Never auto-link accounts by unverified email.
- API keys: 32 random bytes, base64url, shown once; store only a SHA-256 hash plus a short plain prefix for lookup.
- Encrypt channel configs and secrets at rest. Never log tokens, keys, webhook URLs, or secrets.
- Every query is scoped to the caller's team. Test cross-team access explicitly (user A must never read team B).
- Rate-limit monitor creation and the tick endpoint. Validate all input.
- Personal data (emails) is minimal and deletable (POPIA). The demo uses seeded or synthetic data.
- **Demo mode:** a "try demo" path with seeded read-only data, so recruiters need not authorize GitHub.

**Abuse:** the platform makes requests to third-party sites. Enforce a minimum interval, a per-team monitor cap, and a clear `User-Agent` (`HealthMonitor/1.0`). Ownership verification of monitored URLs is a documented stretch.

## 9. Fallback plan: Option B (Cloudflare-native TypeScript)
Switch only if the Phase 0 spike fails or the developer decides otherwise.
- Workers (TypeScript, Hono), Cron Trigger runs checks directly, D1 (SQLite), GitHub OAuth, React on Pages.
- **Free-plan limits to design around (verify at build time):** 100,000 requests/day; 50 subrequests per invocation (about 40 checks per tick plus alert calls); 10 ms CPU per invocation (waiting on fetch is not CPU); 5 cron triggers per account; D1 100,000 rows written/day and 5 million read/day, and when a daily limit is hit **queries stop until midnight UTC**. Estimate: about 4 rows written per check, so roughly 100 monitors at 5-minute intervals.
- **Not possible on free Workers:** secure password hashing (PBKDF2 at 600,000 iterations costs far more than 10 ms), which is why OAuth-only. Workers can check IP literals and hostnames for SSRF but cannot pin the resolved IP.
- **To make the port cheap:** keep the state machine, rule resolution, and uptime calculation as pure, framework-free code, and share JSON test vectors in `contract-tests/*.json` that both implementations must pass.

## 10. Data model (starting point; refine)
`users`(github_id, ...), `teams`, `team_members(role)`, `projects(team_id, deleted_at)`, `monitors(project_id, url, interval_seconds, timeout_ms, latency_threshold_ms, expected_status, expected_text, state, next_run_at, lease_until)`, `check_results(monitor_id, checked_at, success, status_code, response_ms, error)`, `check_rollups_hourly`, `incidents(monitor_id, started_at, resolved_at)`, `notification_channels`, `alert_rules`, `alert_events`, `alert_deliveries`, `api_keys(prefix, hash, team_id, last_used_at, revoked_at)`. Flyway migrations. Soft-delete projects; purge after a retention period.

## 11. Observability of the platform itself
Spring Boot Actuator + Micrometer (checks run, check duration, failures, tick duration, queue lag, alerts sent), structured JSON logs with a correlation id per check, a health endpoint. A monitoring tool must be monitorable.

## 12. Conventions
Constructor injection only. DTOs at the API boundary (never expose entities). Consistent error format. API under `/api/v1`, documented with OpenAPI. Small commits with conventional messages (`feat:`, `fix:`, `test:`, `docs:`). Every feature ships with tests: unit tests for the pure domain, Testcontainers for scheduler and repository logic, WireMock for the checker.

## 13. Commands (update once scaffolded)
```
./mvnw clean verify
./mvnw spring-boot:run -Dspring-boot.run.profiles=api
./mvnw spring-boot:run -Dspring-boot.run.profiles=worker
cd frontend && npm install && npm run dev
docker compose up --build        # backend + MySQL + Mailpit + chaos-target locally
```
Develop everything locally in Docker Compose first. Hosting is only needed for Phase 0 and the final deploy.

## 14. Stretch (only after the MVP works)
- **Events API:** the monitored app calls `POST /api/v1/events` with an API key so users can alert when an endpoint is actually called. Polling cannot detect real traffic. This is the answer to "alert when an endpoint is triggered".
- Heartbeat (push) monitors, SSL certificate expiry alerts, public status page, ownership verification of monitored URLs, Telegram.

## 15. How to work with me (the developer)
I am a student learning to think like an engineer.
- Explain WHY, and state the trade-off when you pick an approach. Challenge my requests if they are wrong, risky, or overengineered. Do not just agree.
- Do not invent APIs, library features, config properties, or versions. If unsure, say so and tell me what to verify (official docs, the version in `pom.xml`).
- Label fact versus inference versus recommendation. State assumptions explicitly. Ask a question only when the answer would change the design materially.
- Keep diffs small and reviewable. Tell me how to test and verify each change.
- Free-tier limits and prices change. Anything marked "verify" must be checked against the provider's current docs before relying on it.
