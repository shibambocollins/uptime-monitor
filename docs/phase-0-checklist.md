# Phase 0 checklist: deployment spike

**Question this answers:** can Option A (Spring Boot on Render free + Aiven MySQL + Cloudflare cron trigger) run the scheduler reliably on free tiers? If yes, build on it. If no, apply the fixes in CLAUDE.md §4, then switch database, then fall back to Option B.

**Time-box:** about two evenings of build work, plus a 24-hour soak that runs unattended. Stop rescuing Option A when the time-box is spent.

**Rule:** the thresholds in section 3 are proposals. Edit them before the first deploy, then freeze them. Changing a threshold after seeing the result turns the test into a rationalisation.

## 1. Facts checked on 2026-10-15

Re-check anything here before relying on it if more than a month has passed.

| Fact | Source |
|---|---|
| Render free: 750 instance hours per **workspace** per calendar month. When they run out, **all** free web services in the workspace are suspended until the next month. | [Render: Deploy for Free](https://render.com/docs/free) |
| Render free: spins down after 15 minutes with no inbound traffic; spin-up takes about one minute. | same |
| Render free: no shell or SSH access. Local files are lost on redeploy, restart, or spin-down. Render may restart a free service at any time. | same |
| Render free: outbound ports 25, 465 and 587 (SMTP) are blocked (since September 2025). | same; [Render changelog](https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports) |
| Render free: may suspend a service that "initiates an uncommonly high volume of traffic over the public internet". | [Render: Deploy for Free](https://render.com/docs/free) |
| Render image deploys: public images from any reachable registry, `linux/amd64` only. The docs do **not** say whether the Free instance type supports image-backed services. | [Render: Deploy a prebuilt image](https://render.com/docs/deploying-an-image) |
| Cloudflare Workers Free: 100,000 requests/day; 10 ms CPU per invocation (waiting on `fetch()` does not count); a cron invocation may run up to 15 minutes wall time; 5 cron triggers per account; no fixed timeout on a single `fetch()`. | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Spring Boot: every 3.x line is out of open-source support (3.5 ended 30 June 2026). 4.1 is current, with OSS support to 31 July 2027 and Java 17-26. | [endoflife.date/spring-boot](https://endoflife.date/spring-boot) |

**Still unverified:** Render free RAM and CPU (512 MB / 0.1 CPU comes from DECISIONS.md; the free-tier page does not state it, so check the pricing page or the service's settings); Aiven free MySQL version and connection limit; whether a non-standard SMTP port (such as 2525) is reachable from Render free.

## 2. What these facts change (inference, not fact)

- **Only one always-awake free service fits.** A cron tick every minute means the service never reaches 15 idle minutes, so it runs 24/7: about 744 hours in a 31-day month, out of 750 for the whole workspace. A second free web service in the same workspace (for example `chaos-target`) would exhaust the hours and suspend both. Host `chaos-target` somewhere else, such as a Cloudflare Worker.
- **Memory must be measured from inside the app.** No shell means no `jcmd` or `top`. Log the process RSS (`VmRSS` from `/proc/self/status`) and JVM heap on every tick, and cross-check against Render's metrics page.
- **The sleep-and-wake test has to be staged.** With a 1-minute cron the service never sleeps on its own, so pause the cron for 20+ minutes.
- **Email from Render needs another route.** SMTP on the standard ports will not work. Options: a provider's SMTP on a non-standard port (if Render allows it), or the provider's HTTP API behind our own `EmailSender` interface, with Mailpit over SMTP kept for local development. The spike tests both, and the result updates CLAUDE.md §7.
- **Choose the Spring Boot version deliberately.** Recommendation: 4.1.x. A new project on an unsupported line gets no security patches and looks careless in a portfolio. Trade-off: most tutorials and answers online still show 3.x, and some starter names and APIs changed in 4.x, so take dependency lists from Spring Initializr, not from blog posts. CLAUDE.md §3 still says 3.x; update it once you decide.

## 3. Pass criteria (proposed: edit, then freeze)

All must hold. Record measurements in section 6.

| # | Criterion | Threshold | How to measure |
|---|---|---|---|
| P1 | Starts without running out of memory | No OOM kill on any deploy; startup ≤ 90 s | Render events; the `Started … in X seconds` log line |
| P2 | Memory headroom | Peak RSS ≤ 400 MB (about 20% headroom under 512 MB) | RSS log line on each tick |
| P3 | No memory growth | RSS at hour 24 ≤ RSS at hour 2 + 10%; heap used after GC roughly flat | Compare log lines (hour 2 is after warm-up) |
| P4 | Database over TLS with a small pool | TLS on (`Ssl_cipher` non-empty) and certificate verified (`sslMode=VERIFY_CA`, or write down why not); Hikari max pool 3; 0 connection timeouts in 24 h | `SHOW SESSION STATUS LIKE 'Ssl_cipher'` run by the app; Actuator metric `hikaricp.connections.timeout` |
| P5 | Tick endpoint is protected | No header → 401; wrong secret → 401; correct secret → 2xx; comparison is constant-time | curl, plus unit tests |
| P6 | Ticks arrive | ≥ 1,426 of 1,440 ticks recorded in 24 h (99%) | Count rows in `spike_ticks` |
| P7 | Ticks finish in time | 10 checks per tick; p95 tick ≤ 10 s, max ≤ 30 s | Durations in `spike_ticks` |
| P8 | Survives sleep and wake | After ≥ 20 min with the cron paused and Render showing the service spun down, the next tick returns 2xx within 120 s, **or** it fails and the following tick succeeds; no tick processed twice | Worker logs; `spike_ticks` |
| P9 | Stable | 0 unplanned restarts during the 24 h soak | Render events |
| P10 | Hour budget understood | Instance hours used during the soak recorded (expect about 24) | Render usage page |

P6 allows about 14 missed ticks, enough for one restart by Render.

## 4. Build steps

One branch and one PR per step (CLAUDE.md §12). CI must be green before merging.

**Keep the spike close to the real app.** Include the dependencies you will actually ship (Web, Security, Data JPA, Flyway, Actuator, MySQL driver). A bare hello-world uses less memory, so it could pass P1-P3 here and still fail once the real app is built.

- [ ] **Step 1: `chore/scaffold`**
  - [ ] Decide the Spring Boot version (section 2) and update CLAUDE.md §3.
  - [ ] Generate from Spring Initializr: Maven, Java 21, Spring Web, Spring Security, Spring Data JPA, MySQL Driver, Flyway, Actuator, Validation, Testcontainers. Record the generated versions in CLAUDE.md §3 instead of editing them by hand.
  - [ ] Add `.gitattributes` with `mvnw text eol=lf` and `*.sh text eol=lf`. This machine has `core.autocrlf=true`, and a CRLF `mvnw` copied into a Linux Docker build fails with `bad interpreter`.
  - [ ] `./mvnw clean verify` passes locally.
- [ ] **Step 2: `ci/build`**
  - [ ] `.github/workflows/ci.yml`: runs on `pull_request` and on `push` to `main`; sets up Temurin 21 with the Maven cache; runs `./mvnw -B clean verify`; `permissions: contents: read`.
  - [ ] After the first green run, protect `main`: require the CI check, block force-pushes.
- [ ] **Step 3: `feat/tick-endpoint`** (spike-only code goes in a `spike` package)
  - [ ] Flyway migration for `spike_ticks` (id, started_at, finished_at, checks_ok, checks_failed, rss_kb, heap_used_kb) and `spike_checks` (tick_id, checked_at, status_code, response_ms, error). To remove them after Phase 0, add a new migration that drops them; never delete or edit an applied migration.
  - [ ] `POST /internal/tick` requires the header `X-Tick-Secret`, compared with `MessageDigest.isEqual` on the bytes (constant-time). The secret comes from an environment variable and is never logged.
  - [ ] Each tick runs 10 HTTP GETs to the Worker's `/ping` route (step 6) with bounded concurrency and a timeout, writes one `spike_ticks` row and 10 `spike_checks` rows, and logs RSS and heap. Why `/ping`: a real outbound HTTPS request exercises the HTTP client's memory without sending spike traffic to someone else's site.
  - [ ] Tests: the secret check (missing, wrong and correct header); a Testcontainers MySQL test that migrations apply and one tick writes 11 rows.
- [ ] **Step 4: `chore/docker`**
  - [ ] Multi-stage `Dockerfile` (build on a JDK 21 image, run on a JRE 21 image). JVM flags come from `JAVA_TOOL_OPTIONS`, so they can be tuned without a rebuild. Start with `-Xmx256m -XX:+UseSerialGC`.
  - [ ] `docker-compose.yml` with the app and MySQL.
  - [ ] **Rehearse Render locally:** run the app container with `--memory=512m --cpus=0.1`. If it fails here it will fail on Render, and finding out costs nothing.
  - [ ] Add a CI job that builds the image, so Dockerfile breakage is caught on the PR.
- [ ] **Step 5: `ci/image`** (only if Render's own build runs out of memory or is too slow)
  - [ ] Workflow on `main`: build the image and push it to GHCR as a public package.
  - [ ] Test whether a Free instance can deploy it (the docs do not say) and record the answer in DECISIONS.md.
- [ ] **Step 6: `feat/tick-worker`**
  - [ ] Cloudflare Worker in `tick-worker/` (TypeScript): a `* * * * *` cron calls `POST /internal/tick` with the secret, and a `GET /ping` route returns 200 for the fake checks.
  - [ ] Set the secret with `wrangler secret put`; never put it in the Wrangler config file.
  - [ ] Add a typecheck job to CI. Deploy manually with `wrangler deploy` for now; a deploy workflow can wait.
  - [ ] Request budget: 1,440 cron calls + 14,400 pings ≈ 15,840 a day, about 16% of the 100,000 free limit. Turn the pings off after Phase 0.
- [ ] **Step 7: Deploy** (configuration only, no branch needed)
  - [ ] Aiven: create the free MySQL service and record its version (`SELECT VERSION()`) and connection limit.
  - [ ] Render: free web service built from the repo's Dockerfile, with environment variables for the DB URL, user, password, tick secret and `JAVA_TOOL_OPTIONS`. No secrets in the repo.
  - [ ] `spring.datasource.hikari.maximum-pool-size=3`.
- [ ] **Step 8: Run the tests**
  - [ ] P5 with curl, then P8 (pause the cron, wait for spin-down, resume), then start the 24 h soak for P1-P4, P6, P7, P9 and P10.
- [ ] **Step 9: Side probes** (not pass criteria, but they settle open items cheaply while everything is connected)
  - [ ] **Email:** from Render, try one send over SMTP on a non-standard port your provider supports, and one send through the provider's HTTP API. Record which works.
  - [ ] **`SKIP LOCKED`:** in two sessions on Aiven, lock rows with `SELECT … FOR UPDATE SKIP LOCKED` in the first and confirm the second skips them.

## 5. If something fails

Follow CLAUDE.md §4 in order: tune (JVM flags, lazy initialisation, fewer Tomcat threads, Flyway in CI, image built in CI), then switch database (TiDB or Neon) if the database is the problem, then fall back to Option B. Write down which criterion failed and what you tried.

## 6. Results (fill in)

| # | Threshold | Measured | Pass? | Notes |
|---|---|---|---|---|
| P1 | No OOM; startup ≤ 90 s | | | |
| P2 | Peak RSS ≤ 400 MB | | | |
| P3 | RSS growth ≤ 10% from hour 2 to hour 24 | | | |
| P4 | TLS verified, pool 3, 0 timeouts | | | |
| P5 | 401 / 401 / 2xx | | | |
| P6 | ≥ 1,426 ticks | | | |
| P7 | p95 ≤ 10 s, max ≤ 30 s | | | |
| P8 | Wakes within 120 s or next tick succeeds | | | |
| P9 | 0 unplanned restarts | | | |
| P10 | Hours used recorded | | | |

- Spring Boot version:
- Aiven MySQL version / connection limit:
- Render free RAM / CPU (as shown in the dashboard):
- Email probe result:
- `SKIP LOCKED` result:
- Image deploy on Free:

**Decision:** ☐ Option A confirmed ☐ Fixes applied, re-run ☐ Database switched ☐ Fall back to Option B

Record the decision and the evidence in DECISIONS.md.
