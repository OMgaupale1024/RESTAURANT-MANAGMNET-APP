# Deployment

Production runbook for OraOS. The philosophy is the same as the code: a
misconfigured deploy should **fail to boot**, not boot insecure. The API
validates its whole environment at startup and crashes on anything unsafe in
production (`apps/api/src/config/env.ts`).

See also: [ENVIRONMENT.md](ENVIRONMENT.md) (every variable) ·
[RUNBOOK.md](RUNBOOK.md) (operations) · [BACKUP_RESTORE.md](BACKUP_RESTORE.md) ·
[SECURITY.md](SECURITY.md) · [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).

## Prerequisites

- A **Postgres** database — Neon (publicly-trusted TLS, so `verify-full` needs no
  custom CA). Any Postgres 15+ works.
- A host for the **API** (container or Node buildpack) and one for the **web**
  app (container, Node, or Vercel).
- **Node 22** and **pnpm 11** if building from source; **Docker + Compose** if
  using the container path.
- A **secret manager** for `JWT_SECRET`, the two DB URLs, and the mail key.
- **DNS** control for two same-site hostnames (web + API) and **TLS**
  certificates (via the platform or a reverse proxy).
- A **Resend** account (`RESEND_API_KEY` + a verified `MAIL_FROM`) for real
  email — optional; without it, email is logged, not sent.

## Target stack

From BLUEPRINT §10. Either deploy from source on a Node/Next buildpack (below),
or use the containers added in Release M5 (see **Docker** section).

| Layer | Service | Notes |
|---|---|---|
| Web (Next) | Vercel | Native Next build |
| API (NestJS) | Railway or Fly.io | Node buildpack; start `node dist/main` |
| Postgres | Neon | Publicly-trusted TLS cert, so `verify-full` works with no custom CA |
| Errors | Sentry | Not yet wired — add when there is real traffic |

**Domain layout matters (BACKLOG #2).** The refresh cookie is
`SameSite=Strict`, so the web app and the API must be same-site: put them under
one apex, e.g. `app.example.com` (web) and `api.example.com` (API). A separate
apex for the API breaks refresh — the browser will not send the cookie.

## Secrets

Never commit `.env`. Both apps read everything from the environment.

**API** (`apps/api`):

| Var | Notes |
|---|---|
| `NODE_ENV` | `production` — turns on the boot-time guards below |
| `PORT` | Provided by the platform |
| `DATABASE_URL` | Owner role, **migrations only**. `sslmode=verify-full` required |
| `DATABASE_URL_APP` | Least-privilege `oraos_api` role, all runtime traffic. `sslmode=verify-full` required. Must differ from `DATABASE_URL` or the app refuses to boot |
| `JWT_SECRET` | ≥32 chars, unique per environment. `openssl rand -base64 48` |
| `CORS_ORIGINS` | The web origin(s), comma-separated. Must all be `https://` in production |
| `WEB_URL` | `https://app.example.com`. Used to build invite links |
| `JWT_ACCESS_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS`, `LOG_LEVEL` | Optional; sane defaults |

**Web** (`apps/web`): `NEXT_PUBLIC_API_URL=https://api.example.com/api/v1`.

### Provisioning the runtime DB role (BACKLOG #10)

The `oraos_api` role's password must never reach the repo or a committed file.
For production, generate it and pipe straight into your secret manager — it is
printed to stdout only and never written to disk:

```bash
DATABASE_URL="<owner url>" pnpm --filter @oraos/api db:setup-app-role -- --print
# stdout is exactly the DATABASE_URL_APP connection string; store it as a secret.
```

(The no-flag form writes to `apps/api/.env` and is for local dev only.)

## Deploy sequence

Migrations run as a **separate step before** the app deploys, and every
migration must be backward-compatible with the version still running — otherwise
deploy is downtime (BLUEPRINT §10).

```bash
# 1. Migrate (owner role). Non-interactive; no shadow DB, unlike migrate dev.
DATABASE_URL="<owner url>" pnpm --filter @oraos/api db:migrate:deploy

# 2. Build and start the API
pnpm --filter @oraos/api build
pnpm --filter @oraos/api start:prod        # node dist/main

# 3. Deploy the web app (Vercel builds it)
pnpm --filter @oraos/web build
```

The `oraos_api` role and RLS policies are created by the migrations plus a
one-time `db:setup-app-role` (owner privileges). Run that once per environment.

## Health probes

- `GET /api/v1/health` — **liveness**. Process is up. No DB touch, so a DB blip
  does not get a healthy process killed. Point the platform's restart probe here.
- `GET /api/v1/health/ready` — **readiness**. Pings the DB (`SELECT 1`); returns
  503 if it is unreachable. Point the traffic/rollout probe here so an API with
  a dead DB is taken out of rotation instead of erroring every request.

On SIGTERM (redeploy) the API drains in-flight requests and disconnects the
Postgres pool via shutdown hooks before exiting.

## Docker

Both apps ship multi-stage, non-root, healthchecked images. The build context is
the **repo root** (pnpm workspace).

```bash
cp .env.example .env          # fill in real values
docker compose up -d --build  # migrate (one-shot) → api → web
```

- `migrate` runs `prisma migrate deploy` with the **owner** `DATABASE_URL`, then
  exits; `api` waits for it (`service_completed_successfully`).
- `api` runs as non-root, connects via `DATABASE_URL_APP`, `HEALTHCHECK` →
  `/api/v1/health`; SIGTERM (on `docker stop`/redeploy) drains and disconnects.
- `web` is a Next standalone image; `NEXT_PUBLIC_API_URL` is a **build arg**
  (baked into the bundle + CSP), `HEALTHCHECK` → `/healthz`.
- Image bases are `node:22-alpine`; the API needs no Prisma query-engine binary
  (`@prisma/adapter-pg` uses the `pg` driver).

Individual builds:

```bash
docker build -f apps/api/Dockerfile -t oraos-api .
docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.example.com/api/v1 -t oraos-web .
```

## HTTPS and reverse proxy

TLS is **mandatory** in production — the API refuses to boot unless
`CORS_ORIGINS` and `WEB_URL` are `https://`, cookies are set `Secure`, and helmet
sends HSTS.

Two common topologies:

**Platform-terminated TLS (Vercel / Railway / Fly).** The platform provisions
and renews certificates and terminates TLS at its edge, forwarding plain HTTP to
the container. The API already runs behind a proxy: `app.set('trust proxy', 1)`
trusts the first hop, so `X-Forwarded-For` (used for rate-limit keying) and
`X-Forwarded-Proto` are honoured. **Verify the hop count** — if your platform
chains more than one proxy, the client IP will be a proxy address and rate
limiting keys on the wrong value; raise `trust proxy` to the real depth for that
platform.

**Self-managed reverse proxy (nginx / Caddy).** Terminate TLS at the proxy and
forward to the API (`:3001`) and web (`:3000`) containers. Minimal nginx for the
API host:

```nginx
server {
  listen 443 ssl;
  server_name api.example.com;
  ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;                 # WebSocket (Socket.IO)
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

Caddy does the same with automatic certificates in two lines
(`api.example.com { reverse_proxy 127.0.0.1:3001 }`).

### Domains

Web and API must be **same-site** so the `SameSite=Strict` refresh cookie is
delivered — e.g. `app.example.com` (web) and `api.example.com` (API) under one
registrable domain. A separate apex for the API breaks refresh. Point both A/CNAME
records at the respective hosts, then set `WEB_URL`, `CORS_ORIGINS`, and the
web build's `NEXT_PUBLIC_API_URL` to the https URLs.

### SSL renewal

- **Platform-terminated:** renewal is automatic; nothing to do.
- **Let's Encrypt via certbot:** certificates last 90 days. `certbot renew` (via
  its systemd timer/cron) renews at ~60 days; reload the proxy on success
  (`--deploy-hook "nginx -s reload"`). Caddy renews automatically. **Monitor
  expiry** regardless — an expired cert takes the whole app down.

## Rollback

The application layer is stateless, so a rollback is a redeploy of the previous
artifact. The database is the part that needs care.

**Code / image rollback (safe, fast):**

```bash
# Docker Compose: rebuild from the previous commit/tag.
git checkout <previous-tag> && docker compose up -d --build api web
# Or repoint to a previously built image tag if you push images to a registry.
```

Because every migration is **backward-compatible with the previous app version**
(the zero-downtime rule), the old code runs fine against the newer schema — a
code rollback needs **no** database change. This is the normal, low-risk path.

**Migration rollback (rare, careful):** Prisma migrations are forward-only — do
**not** edit or delete an applied migration. To undo a schema change, ship a **new**
migration that reverses it (still backward-compatible). To undo bad *data*,
restore from PITR into a scratch branch and reconcile
([BACKUP_RESTORE.md](BACKUP_RESTORE.md#recovery-checklist)).

**After any rollback:** confirm `GET /health` shows the expected `version`, both
health endpoints are `200`, and one real login + write succeed.

## Backups

Neon point-in-time restore is the backup of record. An untested backup is not a
backup (BLUEPRINT §8): schedule a periodic **restore drill** and record it. Full
strategy, verification drill, recovery checklist, and disaster recovery are in
[BACKUP_RESTORE.md](BACKUP_RESTORE.md).

## Known operational gaps

- **External error alerting (Sentry) not wired.** Errors are logged once with a
  request id, but nothing pages an operator. Add Sentry or platform log alerts on
  `level:50` before real traffic.
- **Email verification (#2)** — a registrant's address is not verified. Distinct
  from password reset (shipped); lower urgency (a fake email hurts the
  registrant, not the business).
- **Per-recipient reset throttling** and **credential-stuffing defence** — see
  [SECURITY.md](SECURITY.md#operational-recommendations) and BACKLOG #8.

CI is automated (GitHub Actions): every push/PR runs lint, typecheck, unit + e2e
tests, both app builds, and both docker builds.
