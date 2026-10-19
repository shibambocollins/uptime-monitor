# DECISIONS.md — options considered and why

> **Current plan: Option B (Cloudflare Workers + D1, TypeScript), chosen 2026-10-19. Read §10 first.** Sections 1-5 record the evaluation done while Option A (Spring Boot + Render + Aiven) was the plan; "chosen for A" marks what A would use if the project falls back to it.

Context: solo student project, no usable payment card, no custom domain, months of time. The original goal was a Java backend portfolio piece; since the developer has other Java projects, the goal is now backend range (see §10). Facts below came from web searches in October 2026 (provider docs where possible, otherwise blogs). **Free tiers change often. Verify anything here before relying on it.**

## 1. Hosting the backend
| Option | Verdict | Why |
|---|---|---|
| **Render free (chosen for A)** | Use, with a tick-driven design. Under B it hosts only `chaos-target` | No card. Sleeps after 15 min idle, 30-60 s wake, 512 MB RAM, 0.1 CPU, 750 instance hours/month. Pinging to prevent sleep is not officially supported, so the design must survive a sleep |
| Oracle Cloud Always Free | Rejected | Needs a card at signup (no PIN debit, virtual, prepaid, or single-use cards). Arm allowance reportedly cut to 2 OCPU / 12 GB in mid-2026; capacity errors and idle reclamation |
| Azure | Rejected | Student subscription disabled; personal free account needs a card and has bill risk |
| Google Cloud, AWS, DigitalOcean | Rejected | Need a payment method for free tiers |
| Fly.io, Koyeb | Rejected | Card required (Koyeb reportedly added a hold in 2026; vendor-reported) |
| Hugging Face Docker Spaces | Rejected | Official docs: compute Spaces need a paid plan |
| **Cloudflare Workers (chosen for B, current)** | Use (see §10) | Free, no card, but not a place for a JVM app, so choosing it meant TypeScript |
| Cloudflare Containers | Rejected | Free allowance about 375 vCPU-minutes/month (about 6 hours); an always-on service needs about 43,800 |
| Home machine + Cloudflare Tunnel | Backup demo option | Free but power/internet outages create false downtime |
| Local-only demo + video | Last resort | Weaker but never blocks |

## 2. Database
| Option | Verdict |
|---|---|
| **D1 (chosen for B, current)** | SQLite on Cloudflare. Daily read/write quotas that hard-stop queries; see §10 and CLAUDE.md §5 |
| **Aiven free MySQL (chosen for A)** | No card, real MySQL, 1 CPU, 1 GB RAM, 1 GB disk, single node, connection limits, may power off if unused |
| TiDB Cloud Starter | Backup. MySQL-compatible, not MySQL: needs TLS with CA, scales to zero, billed in Request Units. Free quota is 5 GiB and 50M RUs per cluster per official docs (pricing page shows larger numbers; check). Locking differs, so test `SKIP LOCKED` |
| Neon / Supabase Postgres | Acceptable engine switch. Permanent free tiers, no card. `SKIP LOCKED` works natively. Supabase may pause inactive projects (verify) |
| Filess.io | Rejected: 10 MB per database |
| Render free Postgres | Rejected: expires after 30 days |
| Clever Cloud | Unverified limits |

## 3. Scheduling trigger
**Under B (current):** a Cron Trigger invokes the `app` Worker's `scheduled()` handler directly every minute; nothing needs waking.

Under A: Render sleeps, so the app cannot own its timer. Options: GitHub Actions cron (5-minute minimum; delays; private-repo minutes cap; scheduled workflows may be disabled after inactivity, verify) or **Cloudflare Worker Cron Trigger (chosen for A)**: 1-minute minimum, 5 triggers per free account, no repo requirement. The internal `@Scheduled` trigger remains behind a flag. A free external pinger service is a further fallback.

## 4. Option A vs Option B (final comparison)
| Factor | A: Spring Boot + Render + Aiven | B: Cloudflare-native TypeScript |
|---|---|---|
| Scheduling | External tick; Render may need a wake | Cron invokes the Worker directly |
| Capacity | 512 MB / 0.1 CPU (unmeasured) | 50 subrequests, 10 ms CPU, 100k D1 writes/day |
| Database | MySQL: transactions, `SKIP LOCKED` | SQLite (D1): daily quotas hard-stop queries |
| Passwords | N/A (GitHub OAuth) | Free-plan hashing impractical, so OAuth only |
| SSRF | Full control: resolve DNS, pin IP | Hostname and literal checks, no IP pinning |
| Ops | 4 pieces (Render, Aiven, Pages, trigger Worker) | One platform |
| Portfolio | Java, Spring Security, JPA, Docker | TypeScript, serverless/edge |
| Main risk | Free Render fit and cold starts | Quota ceilings, SSRF gap |

**Decision (superseded on 2026-10-19, see §10):** A, gated by the Phase 0 spike, with B as the planned fallback. Reasons: matches Java role targets; the hard engineering (SKIP LOCKED claiming, DNS-pinned SSRF defense, transactional outbox) lives in A; B's free-tier limits would shape the design.

**Option B request estimates (assumptions, 3-6 users; the write figures are superseded by §10 and CLAUDE.md §5):** a cron every minute is 1,440 requests/day. Development about 2-7% of the 100,000 daily requests; production 3 users about 2%, 6 users with dashboards open about 8%. The binding limit is D1 writes at about 4 rows per check: 30 monitors at 5-minute intervals is about 35% of the daily write cap; 30 monitors at 1-minute intervals exceeds it.

## 5. Alert channels
- **Email (chosen):** free tiers exist (indicative from mid-2026 comparisons: Resend 3,000/month and 100/day, Brevo 300/day with footer, Mailgun 100/day; SendGrid's standalone free tier is gone). Verify current limits. Under B, email goes through the provider's HTTP API behind an `EmailSender` interface (SMTP is blocked; see CLAUDE.md §7), and without a domain it reaches only the account owner. Under A, SMTP via JavaMailSender was the plan.
- **Discord (chosen):** webhook URL pasted by the user; no bot needed; roughly 5 requests per 2 seconds per webhook; URL is an unauthenticated secret.
- **Telegram:** Bot API is free, but the user must start the bot first. Deferred.
- **SMS:** paid per message; not verified for South Africa. Deferred.
- **WhatsApp:** needs Meta approval; messages outside the 24-hour customer window must use pre-approved templates; since 1 July 2025 each delivered business-initiated template is billed; alerts are usually outside the window. Out of scope.
- **Rule model:** both team-level channels and per-user subscriptions were chosen, built in that order on one `alert_rules` table (`target_type = CHANNEL | USER`).

## 6. Auth
GitHub OAuth chosen (developer audience; free; simplest). Google is a possible second provider; Microsoft needs an Entra app registration and is more friction. Never store passwords in this project. Key users by GitHub numeric ID.

## 7. "Alert when an endpoint is triggered"
Interpretation 1 (alert when a specific endpoint fails or is slow) is in the MVP via monitor-level rules. Interpretation 2 (alert when an endpoint is actually called by real traffic) cannot be done by polling; it needs the monitored app to report events. Stretch: an events API using API keys.

## 8. Considered and parked project ideas
College applications platform (the idea that preceded this one): the premise was only partly true, since a central application service may already exist and each college runs its own portal; it also needs institutional buy-in and has POPIA exposure. SOC alert-triage agent with an evaluation harness remains a strong alternative project. Other listed ideas: double-entry ledger, stokvel manager.

## 9. Open items to verify (do not assume)
**Option B (current).** The Phase 0 spike settles most of these; see `docs/phase-0-checklist.md` §1 and §4 step 8.
- Whether a `db.batch()` counts as one query or many toward the 50 per invocation.
- Whether D1 calls count toward the 50 subrequests per invocation (if so, "about 40 checks per tick" shrinks).
- Whether D1 supports `WITHOUT ROWID` tables (the rollup table relies on it to avoid an extra index row; CLAUDE.md §5).
- Current free-tier limits for the email provider, Workers, D1 and Render.
- Whether Google/Microsoft sign-in is wanted later.

**Answered:** D1 deletes count as rows written, and writing a column that is part of an index adds at least one more row written ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), checked 2026-10-19).

**Option A only (relevant only on fallback):** Java and Spring Boot versions; Render prebuilt-image support on free; JVM memory fit; Aiven connection limits; whether `SKIP LOCKED` behaves as expected on the chosen MySQL version; whether Cron Trigger calls to Render survive cold starts.

- **Found 2026-10-15 (sources in `docs/phase-0-checklist.md` §1):** Render free blocks outbound SMTP ports 25, 465 and 587, so the email transport in CLAUDE.md §7 is open until the Phase 0 email probe. Render's 750 free hours are per workspace, and a service ticked every minute never sleeps (about 744 hours/month), so `chaos-target` cannot be a second free Render service. Spring Boot 3.x is out of open-source support (3.5 ended 30 June 2026; 4.1 is current), so the version in CLAUDE.md §3 needs a decision.

## 10. 2026-10-19: switched to Option B
**Decision:** build Option B (Cloudflare Workers + D1 + Workers Static Assets, TypeScript). Option A becomes the fallback. Full scope kept, with email limited to owner-only.

**Why:**
- The developer has other Java projects, so this one adds TypeScript and serverless range instead of repeating Java. The original main reason for A (Java role fit) no longer dominates.
- No custom domain will be bought. Email to other users is impossible on either option, so email no longer separates A from B.
- B runs on one platform with no sleep and no instance-hour budget; A needed four providers and used about 744 of 750 Render hours per workspace.
- Render free's SMTP block and outbound-traffic suspension clause were risks for A only. The suspension risk was judged low at portfolio volumes, so it was not the deciding factor.

**Accepted costs:** no DNS-pinned SSRF defence (a hostname, IP-literal and DNS-over-HTTPS check is used, with the rebinding gap documented); D1 daily write cap with a hard stop at the limit; about 40 checks per tick; 6 concurrent connections per invocation; 10 ms CPU; no `SKIP LOCKED` (a conditional `UPDATE` lease instead); tied to Cloudflare.

**Facts checked for this decision** ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)):
- D1 Free: 100,000 rows written and 5 million read per day, reset 00:00 UTC; `INSERT`, `UPDATE` and `DELETE` all count as writes; 50 queries per invocation; 500 MB per database; 5 GB per account. Over the daily limit, queries fail.
- Workers Free: 6 connections may wait for response headers at once per invocation; no fixed timeout per `fetch()`.
- Static asset requests are free and unlimited, so the React app is served by the API Worker (same origin) instead of Pages (a separate site, which would make session cookies cross-site).
- A Worker cannot reliably reach another Worker on the same account by its `workers.dev` URL; service bindings are the documented route. A binding skips the real network, so `chaos-target` is hosted on Render free instead, where it uses the workspace's 750 hours alone.

**Corrected estimate:** the old "about 4 rows per check, about 100 monitors at 5 minutes" figure was wrong (100 × 288 × 4 = 115,200 > 100,000). The new write model targets 2 rows per check (about 58% of the cap for 100 monitors). Verified or revised in Phase 0.

**Second correction (same day):** D1 counts an extra row written whenever a write touches an indexed column. The first draft indexed `monitors(next_run_at)`, which the claim `UPDATE` changes on every check, so the real cost was at least 3 rows per check (about 86% of the cap for 100 monitors) and P5 would have failed by design. Fix: no index on `next_run_at` (a full scan of a few hundred monitor rows per tick costs reads, which are plentiful, instead of writes, which are scarce), and the rollup table keyed by a `WITHOUT ROWID` primary key. Details in CLAUDE.md §5.

**Revisit if:** the Phase 0 spike fails its criteria after reducing work per tick, or a domain becomes available and email matters more.
