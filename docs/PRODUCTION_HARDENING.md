# Production Hardening

Canonical status for the OraOS production-hardening effort. If the chat history
is lost, resume from the latest pushed commit and this file.

- **Branch:** `production-hardening`
- **Base:** `main`
- **Current phase:** v1.0 Release Preparation **COMPLETE** — Release Candidate. Production hardening is **frozen** — do not revisit unless a direct regression is found.
- **Current production status:** hardening + release prep complete; no known Critical issues.

## Completed sprints (approved)

| Sprint | Fix | Commit |
|---|---|---|
| C1 | Multi-restaurant picker — read the `rid` claim so multi-restaurant users can sign in | `2cb00bd` |
| H1 | Inventory reversal — return stock to the ledger when an order is voided/cancelled | `fd96d48` |
| M1 | Analytics timezone — anchor the "today" window to the tenant TZ, not the host | `bade365` |
| H4 | Logout Everywhere — logout-all revokes every session; session epoch closes the race; invalidation across select-restaurant/staff/sockets | `4038500`, `9c2281c`, `ce8a326` |
| C3 | Refresh race | (auth cluster above) |
| C4/C5 | Authentication completion | (auth cluster above) |
| H5 | Order idempotency — order creation idempotent on the order, not the payment | `84584a4` |
| 2C / H6 | Inventory adjustment idempotency — exactly-once manual stock movements | `ec745b0` |

## Closed investigations (no code changes)

- **M2 — Timesheet day-boundary.** Investigated + browser-verified; not reproducible. Closed no-code. (2026-07-20)
- **H3 — RBAC runtime hardening.** Runtime permission matrix passed; all mutation routes protected; existing e2e coverage confirmed. Closed no-code. (2026-07-20)

## Sprint 2C — Inventory adjustment idempotency

**Discovered during:** H5 (order idempotency).

**Issue.** Manual inventory mutations (receipt/`PURCHASE`, `WASTE`, and stock-count
`ADJUSTMENT`) were not idempotent. A retry, refresh, double-click, or concurrent
identical request applied the same stock movement twice, corrupting the ledger.

**Fix.** Reused the H5 pattern. Added a nullable `idempotency_key` to
`stock_movements` with a unique index `(restaurant_id, idempotency_key)`; NULLs do
not collide, so server-written `CONSUMPTION` and reversal rows are unaffected. The
two manual-movement service paths now route through `writeOnce(key, write)`: it
returns the existing row for a replay and converts a lost concurrent race
(unique violation) into the original row. The web client sends a per-intent UUID
key, regenerated on input change and after a successful record.

**Files changed.**
- `apps/api/prisma/schema.prisma` — `idempotencyKey` + compound unique on `StockMovement`
- `apps/api/prisma/migrations/20260720205830_stock_movement_idempotency/` — column + unique index
- `apps/api/src/modules/inventory/dto/inventory.dto.ts` — `idempotencyKey` on both DTOs
- `apps/api/src/modules/inventory/inventory.service.ts` — `writeOnce` / `findMovementByKey`
- `apps/api/test/inventory.e2e-spec.ts` — 6 idempotency e2e cases
- `apps/web/src/lib/api.ts`, `apps/web/src/app/dashboard/inventory/inventory-client.tsx` — client sends the key

**Verification.** typecheck ✓ lint ✓ build ✓ · inventory e2e 29/29 ✓ (incl. duplicate
receipt, duplicate adjustment, browser retry, network retry, 5-way concurrent,
distinct keys, no-key). Live-server HTTP probe and full browser UI record →
replay confirmed exactly-once end-to-end.

---

# v1.0 Release Preparation

Production hardening is complete and frozen. This phase prepares OraOS for real
deployment, one small independent milestone at a time (implement → test →
browser-verify → commit → push before the next).

## Milestones

| # | Milestone | Status |
|---|---|---|
| 1 | Invite acceptance security — refresh token via httpOnly cookie, not JSON | ✅ done |
| 2 | Password reset (forgot / token / expiry / email / browser flow) | ✅ done |
| 3 | Email infrastructure (Resend) — real delivery, templates, retry/timeouts | ✅ done |
| 4 | Production monitoring (`/health`, readiness, structured logging, request IDs, error reporting, graceful shutdown) | ✅ done |
| 5 | Docker (API, Web, prod compose, env handling) | ✅ done |
| 6 | GitHub Actions CI (install, lint, typecheck, test, build, docker) | ✅ done |
| 7 | Production deployment docs (env, reverse proxy, HTTPS, guide, backups, migration & rollback) | ✅ done |

**Release Preparation is COMPLETE — OraOS is a v1.0 Release Candidate.**

## Milestone 1 — Invite acceptance security

**Issue.** `POST /join/:token` (invite acceptance) returned the full
`IssuedTokens` — including the **refresh token — in the JSON body**, and never
set the refresh cookie. Login/register put the refresh token in an httpOnly
cookie and return only the access token; the invite path skipped that, so a
stolen-by-XSS refresh token was a persistent session, and an accepted invite's
session would not even survive a page reload (no cookie to refresh from).

**Fix.** Extracted the refresh-cookie contract (`oraos_rt`, httpOnly, `sameSite:
strict`, path `/api/v1/auth`) out of `AuthController` into one shared helper,
and routed both `AuthController` and `JoinController` through it. The invite
path now sets the httpOnly cookie and returns only `{ accessToken, expiresIn,
tokenType }`. Single source of truth for the cookie, so the paths cannot drift.
No web change — the client already used `credentials: 'include'` and ignored any
`refreshToken` field.

**Files changed.**
- `apps/api/src/modules/auth/refresh-cookie.ts` — new shared helper
- `apps/api/src/modules/auth/auth.controller.ts` — use the helper (behaviour-identical)
- `apps/api/src/modules/staff/staff.controller.ts` — `JoinController` sets the cookie
- `apps/api/test/staff.e2e-spec.ts` — asserts cookie set, no `refreshToken` in body, cookie refreshes

**Verification.** typecheck ✓ lint ✓ build ✓ · auth + staff e2e 63/63 ✓. Browser:
invite accepted → no `refreshToken` in body, `oraos_rt` httpOnly cookie at
`/api/v1/auth`, session survived a full reload.

## Milestone 2 — Password reset

**Issue.** No way to reset a forgotten password — the only path back into an
account was an admin. A production requirement.

**Fix.** A single-use, 30-minute, SHA-256-hashed reset token (same shape as
`StaffInvite`), stored in a new `password_reset_tokens` table.
`POST /auth/forgot-password` always returns `204` (no account enumeration) and
fires a fire-and-forget email; `POST /auth/reset-password` validates + atomically
consumes the token, re-hashes the password (bcrypt cost 12), and calls
`TokenService.revokeAllForUser` — a reset ends every existing session. Email is
sent through a new provider-agnostic `MailService.send()` seam (dev transport
logs; Milestone 3 swaps in Resend). No auto-login: the user returns to `/login`.

**Files changed.**
- `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260720184222_password_reset/` — table + two `SecurityEventType` values
- `apps/api/src/modules/mail/{mail.module,mail.service}.ts` — new email seam
- `apps/api/src/modules/auth/{auth.service,auth.controller,auth.module}.ts`, `dto/auth.dto.ts` — reset flow + DTOs
- `apps/api/test/auth.e2e-spec.ts` — 6 reset tests
- `apps/web/src/app/forgot-password/*`, `apps/web/src/app/reset-password/*` — new pages
- `apps/web/src/app/login/login-form.tsx`, `apps/web/src/lib/api.ts` — link + client calls

**Migration.** `20260720184222_password_reset` — `password_reset_tokens` table +
`PASSWORD_RESET_REQUESTED` / `PASSWORD_RESET_COMPLETED` enum values. Applied.

**Verification.** migration ✓ typecheck ✓ lint ✓ build (API) ✓ · auth e2e 35/35 ✓
(valid reset, expired, invalid, reused, logout-all-after-reset, no enumeration).
Web typecheck + lint ✓ (`next build` skipped — disk-constrained; verified via the
live dev build below). Browser: forgot → neutral message + `204`, reset link →
new password set, old password `401` / new `200`, pre-reset session revoked.

## Milestone 3 — Email infrastructure (Resend)

**Issue.** Milestone 2 shipped a `MailService` seam whose only transport logged
instead of sending. Production needs real delivery for password-reset and staff-
invite emails.

**Implementation.** `MailService.send()` now posts to the Resend REST API via
`fetch` (no SDK dependency) with a per-attempt 10s timeout and bounded retries —
transient failures (network, timeout, 429, 5xx) retry up to 3 attempts; a 4xx is
permanent and fails fast. Provider code lives ONLY in `MailService`; callers use
`sendPasswordResetEmail` / `sendStaffInviteEmail`, and a new email is just a new
domain method. Content moved to `mail-templates.ts` (HTML + plain text, both
always). Config (`RESEND_API_KEY`, `MAIL_FROM`) is validated at boot — a key with
no/invalid from-address refuses to start. With no key configured it falls back to
the log transport, so dev/tests need nothing. Staff-invite emails are now sent on
invite creation (fire-and-forget; the `inviteUrl` is still returned as a fallback).
Logging is narrow — to + subject + status only; **tokens, bodies, and the API key
never reach the logs** (production transport), enforced by a unit test.

**Files changed.**
- `apps/api/src/modules/mail/{mail.service,mail-templates}.ts`, `mail.service.spec.ts`
- `apps/api/src/config/env.ts`, `env.spec.ts` — Resend config + validation
- `apps/api/src/modules/staff/{staff.service,staff.module}.ts` — invite email dispatch
- `apps/api/.env.example` — documented the new vars

**Verification.** typecheck ✓ lint ✓ build ✓ · unit 24/24 (Resend payload/auth,
retry, permanent-vs-transient, timeout, no-secret-logging, config validation) ·
auth + staff e2e 69/69. Live: invalid config (`RESEND_API_KEY` without
`MAIL_FROM`) refuses to boot. Browser: password-reset flow end-to-end + reset
email dispatched; staff invite creation dispatches an invite email naming the
restaurant.

**Discovered issues.**
- **CRITICAL — stored XSS via restaurant name in invite email HTML.** The owner-
  controlled restaurant name was interpolated into the invite email's HTML. Fixed
  inline (directly in scope): `mail-templates.ts` HTML-escapes interpolated data
  values. Covered by the invite unit test.
- **RECOMMENDED (reported, not implemented) — password-reset email bombing.**
  `POST /auth/forgot-password` is throttled 5/min per IP but has no per-recipient
  limit, so an attacker rotating IPs could send a victim repeated reset emails
  (links are single-use and prior ones are invalidated, so it's nuisance, not
  account risk). This is the M2 endpoint, not M3 — left for a hardening pass to
  avoid scope creep.

## Milestone 4 — Production monitoring

**Issue.** The app was mostly observable already (pino structured logging, request
ids, an exception filter, helmet, throttling, shutdown hooks) but had gaps: the
health endpoint lacked version/timestamp, there was no slow-request signal, and —
the real find — the staff-invite token leaked into request logs.

**Monitoring architecture (what exists, and what this milestone added).**
- **Health.** `GET /health` (liveness — no DB touch) now returns status, uptime,
  version (`APP_VERSION` or the package version), and timestamp. `GET /health/ready`
  (readiness) runs `SELECT 1` and returns `200 {ready, database:up}` or `503`.
  Both are `@Public` and `@SkipThrottle` — a throttled probe would read as "down".
- **Structured logging.** pino (`nestjs-pino`) emits JSON in production (pretty in
  dev) with timestamp, request id, method, path, status, and duration per request.
- **Request IDs.** `genReqId` propagates a safe caller-supplied `X-Request-Id`
  (bounded charset, ≤64 chars) or generates a UUID, sets it on the response, and
  threads it through every log and error body.
- **Redaction.** Authorization/cookie headers, set-cookie, and password/token/
  refreshToken bodies were already redacted; **added** URL masking (`redactUrl`)
  and `req.params` redaction so the invite token in `/join/:token` never lands in
  a log.
- **Exception handling.** `AllExceptionsFilter` (unchanged) — one JSON shape,
  stack hidden from clients, request id included, 4xx warn / 5xx error once.
- **Slow requests.** `SlowRequestInterceptor` warns once for any request ≥1000ms,
  with the request id and a masked path.
- **Graceful shutdown.** `enableShutdownHooks()` (main.ts) wires SIGTERM/SIGINT;
  shutdown stops the server, disconnects Prisma (`onModuleDestroy`), and runs
  `ShutdownService` (logs the signal). Verified by an integration test.
- **Verified present (OPTIONAL items):** helmet security headers (CSP, HSTS,
  X-Frame-Options, nosniff…), `ThrottlerModule` rate limiting (100/min baseline,
  tighter on auth) — both confirmed live in response headers. Compression: **not
  added** — belongs at the reverse proxy/CDN (Milestone 7), not the app.

**Files changed.**
- `apps/api/src/health.controller.ts` — version/timestamp, `@SkipThrottle`
- `apps/api/src/common/interceptors/slow-request.interceptor.ts` (+ spec)
- `apps/api/src/common/logging/redact-url.ts` (+ spec)
- `apps/api/src/common/lifecycle/shutdown.service.ts`
- `apps/api/src/app.module.ts` — URL-mask serializer, request-id propagation, `req.params` redaction, interceptor + ShutdownService wiring
- `apps/api/.env.example` — `APP_VERSION`
- `apps/api/test/health.e2e-spec.ts`, `test/shutdown.e2e-spec.ts`

**Verification.** typecheck ✓ lint ✓ build ✓ · unit 30/30 (redact-url, slow-request,
mail, env) · e2e health 6 + shutdown 1 + auth regression 35. Live: health fields,
request-id generate/propagate/reject, readiness, structured log fields, and
**invite token absent from logs** (`params:"[REDACTED]"`, url masked). Graceful
shutdown verified by integration test (signals wired; close drains Prisma and runs
the hook) — Windows cannot deliver a catchable SIGTERM to a console app, so the
signal path is proven in-process rather than by killing a live process.

**Discovered issues.**
- **CRITICAL — staff-invite token leaked into request logs.** `/api/v1/join/:token`
  put the token in `req.url` and `req.params`; existing redaction only covered
  headers and bodies. Directly in scope (the "never log invite tokens" rule) →
  fixed: `redactUrl` serializer + `req.params` redaction, covered by unit + live
  test.
- **RECOMMENDED — health probes were rate-limited.** The global throttle applied
  to `/health`; a probe burst could hit `429` and be read as an outage. Fixed:
  `@SkipThrottle()` on the health controller.
- **V1.1 — response compression not implemented.** Deferred to the reverse
  proxy/CDN in Milestone 7 rather than adding an app-level dependency.

## Milestone 5 — Docker & production containers

**Issue.** No container artifacts; deployment relied on platform buildpacks
(Vercel/Railway). Package both apps as reproducible, minimal, non-root images.

**Docker architecture.**
- **API image** (`apps/api/Dockerfile`, context = repo root) — three stages off
  `node:22-alpine`:
  - `build`: `pnpm fetch` → `pnpm install --offline` (with `python3/make/g++` for
    native bcrypt) → `prisma generate` → `nest build` → `pnpm --legacy deploy --prod`
    (self-contained prod bundle: dist + prod `node_modules`, no devDeps, no prisma
    CLI). `@prisma/adapter-pg` means **no query-engine binary** at runtime.
  - `migrator`: thin layer over `build`; `CMD prisma migrate deploy`. Runs as a
    one-shot container with the owner URL before the API starts.
  - `runtime`: the pruned bundle only, non-root `nodejs` user, `HEALTHCHECK` →
    `/api/v1/health`, exec-form `CMD ["node","dist/main.js"]` so PID 1 gets SIGTERM
    (graceful shutdown from M4).
- **Web image** (`apps/web/Dockerfile`) — `next build` with `output: 'standalone'`
  + `outputFileTracingRoot` (monorepo), runtime copies only `.next/standalone`
  (~21 MB) + static + public, non-root, `HEALTHCHECK` → `/healthz` (new route).
  `NEXT_PUBLIC_API_URL` is a build arg (baked into the bundle + CSP).
- **Compose** (`docker-compose.yml`) — `migrate` (one-shot) → `api`
  (`depends_on: service_completed_successfully`) → `web`; bridge network,
  `restart: unless-stopped`, `${VAR:?}` fail-fast on missing config. Config via a
  root `.env` (see `.env.example`).

**Files changed.**
- `apps/api/Dockerfile`, `apps/web/Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example` (new)
- `apps/web/next.config.ts` — standalone + tracing root
- `apps/web/src/app/healthz/route.ts` — web liveness route
- `docs/DEPLOYMENT.md`, `docs/BACKLOG.md` — doc-drift fixes (below)

**Verification.** typecheck ✓ lint ✓ · API `nest build` + `prisma generate` ✓ ·
`pnpm --legacy deploy --prod` produces a complete bundle (dist + bcrypt +
@prisma/client + adapter + `pg` resolvable, prisma CLI excluded) ✓ · **web
standalone build ✓ and the standalone server runs**: `/healthz` → 200, `/login` →
200 with the nonce CSP ✓ · health smoke test 6/6. **Docker daemon is not available
in this environment**, so `docker build`/`compose up` could not be executed here;
every build step the Dockerfiles invoke was exercised directly instead.

**Discovered issue.** `pnpm deploy` requires `--legacy` on pnpm 10+ for a
non-injected workspace — caught by running the deploy locally; the flag is in the
Dockerfile.

## Doc-drift fixes (Recommended #7)
Password reset (M2) and staff-invite email delivery (M3) are shipped; `BACKLOG.md`
#1 and #26 and `DEPLOYMENT.md` updated to reflect that. (Email *verification*,
BACKLOG #2, remains open — distinct from password reset.)

## Milestone 6 — GitHub Actions CI

**Issue.** No CI; all gates (lint/typecheck/test/build) ran manually. Nothing
stopped broken code from reaching a mainline branch.

**CI architecture** (`.github/workflows/ci.yml`, on push to `main`/
`production-hardening` and every PR; sequential steps fail fast; concurrency
cancels superseded runs):
- **`verify` job** — checkout → `pnpm/action-setup` → `setup-node` with
  `cache: pnpm` → `install --frozen-lockfile` → `prisma generate` → **lint**
  (`pnpm -r lint` then `git diff --exit-code`, so an auto-fixable issue still
  fails) → **typecheck** → **unit tests + coverage** → **DB prep** → **e2e** →
  **build API** → **build Web** → upload coverage artifact.
  - DB for e2e: a `postgres:16-alpine` **service** named `neondb` (the app-role
    migration grants `CONNECT` on that name). Prep runs `prisma migrate deploy`
    (schema + RLS + the `oraos_api` role + grants), `db:seed` (global roles &
    permissions — required before staff/auth e2e), then `ALTER ROLE oraos_api
    … LOGIN PASSWORD` so `DATABASE_URL_APP` can connect. `NODE_ENV=test`, so the
    production verify-full/https guards don't apply.
- **`docker` job** — Buildx builds both images (`push: false`, GHA layer cache).
  This is the **first real `docker build` validation** of the M5 Dockerfiles
  (Docker was unavailable in the dev environment).

CI-only env (JWT_SECRET, DB URLs) are non-secret placeholders in the workflow;
no production secrets are used or uploaded.

**Files changed.** `.github/workflows/ci.yml` (new); `apps/api/test/health.e2e-spec.ts`
(prettier formatting — see below).

**Verification.** Docker daemon and `act` are both unavailable locally, so the
workflow itself couldn't be executed here; validated by (a) YAML parse + structure
check, and (b) running every runnable step directly: lint (eslint, both apps),
typecheck (both), unit tests + coverage 30/30, API build, and the Web standalone
build (M5). The e2e DB bootstrap is derived from the migration/seed/role scripts
but was not executed (no local Postgres).

**Repository quality.** `.gitignore`, `.dockerignore`, `pnpm-lock.yaml`, and
`pnpm-workspace.yaml` all present and correct; `--frozen-lockfile` enforces the
lockfile in CI. No changes needed.

**Discovered issues.**
- **RECOMMENDED — committed formatting drift.** `health.e2e-spec.ts` carried a
  prettier violation (from an M4 edit not re-fixed); the new lint gate caught it.
  Fixed (formatting only) so the pipeline is green on current code — and proof the
  gate works.
- **RECOMMENDED (reported) — the API `lint` script uses `--fix`,** so it isn't a
  pure gate. CI compensates with `git diff --exit-code`; a dedicated non-fix
  `lint:ci` script would be cleaner. Not changed (out of automation scope).

## Milestone 7 — Production deployment documentation

**Issue.** Deployment was possible but under-documented; operators lacked
runbooks, an environment reference, backup/recovery procedure, a security
summary, and a go/no-go checklist.

**Documentation created** (`docs/`):
- **DEPLOYMENT.md** (completed) — prerequisites, env, deploy sequence + startup
  order, Docker Compose, **HTTPS & reverse proxy** (platform + nginx/Caddy, trust-
  proxy note), **domains**, **SSL renewal**, **rollback** (code vs migration).
- **ENVIRONMENT.md** — every variable: purpose, required/optional, default,
  example, and the boot-time cross-field rules.
- **RUNBOOK.md** — restart, logs, health, and triage for auth/email/database/
  migration failures and service restore.
- **BACKUP_RESTORE.md** — Neon PITR strategy, the recorded restore drill, recovery
  checklist, and disaster recovery.
- **SECURITY.md** — auth, cookies, JWT, RLS, secrets, CSP, log redaction, and
  operational recommendations.
- **RELEASE_CHECKLIST.md** — the pre-deploy → deploy → post-deploy → smoke → sign-
  off gate.

**Doc sync.** `README.md` links the operations docs and marks the v1.0 RC state;
`DEPLOYMENT.md` stale notes fixed (CI now automated; Docker section current);
`BACKLOG.md` #1/#26 already closed in M5. Recommended findings addressed: doc
drift (#7), trust-proxy verification note, external-error-reporting documentation,
backup restore procedure.

**Verification.** typecheck ✓ lint ✓ · API `nest build` + Web standalone build ✓
· documentation reviewed for accuracy against the implementation.

---

# Release Preparation Complete

All seven milestones and the mid-point Production Readiness Audit are done and
pushed. **No Critical issues remain.** OraOS is a **v1.0 Release Candidate**.

Remaining work is Recommended/V1.1 and tracked in `docs/BACKLOG.md` and the
"operational recommendations" in `docs/SECURITY.md` (external error alerting,
per-recipient reset throttling, credential-stuffing defence, email verification).

## General backlog

See `docs/BACKLOG.md`.
