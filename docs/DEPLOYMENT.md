# Deployment

Production runbook for OraOS. Step 20. The philosophy is the same as the code:
a misconfigured deploy should **fail to boot**, not boot insecure. The API
validates its whole environment at startup and crashes on anything unsafe in
production (`apps/api/src/config/env.ts`).

## Target stack

From BLUEPRINT §10. Nothing here needs a Dockerfile — every layer builds Node /
Next from source.

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

## Backups

Neon does point-in-time restore. An untested backup is not a backup
(BLUEPRINT §8): schedule a periodic **restore drill** into a scratch branch and
confirm the data is intact.

## Not yet automated

- **CI/CD** — intended pipeline (BLUEPRINT §10): PR → typecheck + lint + test +
  migration dry-run → preview deploy → merge → staging → manual gate → prod. Add
  as a GitHub Actions workflow when a hosting target is chosen.
- **Password reset (#1) and email verification (#2)** — both need an email
  provider, which is still an open decision (BLUEPRINT §14). Deferred rather
  than built against a speculative provider. **#1 becomes urgent the moment a
  real restaurant relies on this** — a locked-out owner currently has no
  self-service recovery.
