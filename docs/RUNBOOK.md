# Operations Runbook

What to do when OraOS is misbehaving in production. Assumes the Docker Compose
deployment (`docker-compose.yml`); adapt the commands for a platform deploy
(Railway/Fly/Vercel) — the checks are the same, only the plumbing differs.

Related: [DEPLOYMENT.md](DEPLOYMENT.md) · [ENVIRONMENT.md](ENVIRONMENT.md) ·
[BACKUP_RESTORE.md](BACKUP_RESTORE.md) · [SECURITY.md](SECURITY.md).

## At a glance

| Symptom | First check | Section |
|---|---|---|
| API returns 5xx | `GET /api/v1/health/ready` | [Health](#checking-health), [Database](#database-issues) |
| Users bounced to /login | refresh cookie / same-site domain | [Common failures](#common-failures) |
| No emails arriving | `RESEND_API_KEY` / logs | [Email](#email-issues) |
| Deploy won't start | boot validation crash in logs | [Migrations](#migration-failures), [ENVIRONMENT.md](ENVIRONMENT.md) |

## Service restart

```bash
docker compose restart api          # graceful: SIGTERM drains + disconnects
docker compose up -d --build api    # rebuild + restart after a new image
docker compose ps                   # status + health of every service
```

A restart is graceful: the API traps SIGTERM, stops accepting connections,
finishes in-flight requests, and disconnects the Postgres pool before exiting
(logged as `Shutting down`).

## Viewing logs

Logs are structured JSON (one line per request: timestamp, request id, method,
path, status, duration). Secrets are redacted (Authorization, cookies, tokens,
invite links).

```bash
docker compose logs -f api                       # follow
docker compose logs --since=15m api              # recent window
docker compose logs api | grep '"level":50'      # errors only (50=error,40=warn)
docker compose logs api | grep '<request-id>'    # trace one request end-to-end
```

Every response carries an `X-Request-Id`; quote it from a user report to find
the exact line. `Slow request` warnings flag anything ≥1000 ms.

## Checking health

```bash
curl -fsS http://localhost:3001/api/v1/health        # liveness (no DB)
curl -fsS http://localhost:3001/api/v1/health/ready   # readiness (pings DB)
```

- `/health` → `200 {status, uptime, version, timestamp}`. If this fails, the
  process is down — restart it.
- `/health/ready` → `200 {ready, database:up}` or `503`. A `503` means the API
  is up but the database is unreachable — see [Database](#database-issues). The
  platform's traffic probe should point here so a DB-less API is pulled from
  rotation instead of erroring every request.

## Common failures

**Users get logged out / "session expired" loops.** The refresh cookie is
`httpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`. It only travels when web
and API are **same-site** (e.g. `app.example.com` + `api.example.com`). A cross-
apex API silently drops the cookie. Confirm `WEB_URL`/`CORS_ORIGINS` and the
domain layout ([DEPLOYMENT.md](DEPLOYMENT.md)).

**CORS errors in the browser console.** The origin isn't in `CORS_ORIGINS`
(comma-separated, exact, `https://` in prod). The allowlist is never reflected —
add the origin and redeploy the API.

**Blocked scripts / blank pages after deploy.** CSP is nonce-based and includes
`connect-src` for `NEXT_PUBLIC_API_URL`. If the API URL changed, the **web image
must be rebuilt** (that value is baked at build time).

**429 Too Many Requests.** Rate limiting (100/min per IP baseline, tighter on
auth). Health probes are exempt. A real spike may need the limit tuned; a single
client tripping it is usually a retry loop.

## Email issues

Email is delivered through `MailService` (Resend). No emails means one of:

1. **Provider not configured.** Boot log shows `No mail provider configured
   (RESEND_API_KEY unset) — email is logged, not sent`. Set `RESEND_API_KEY` +
   `MAIL_FROM` and restart.
2. **Delivery failing.** Logs show `Email send failed (transient)` (retried up to
   3×) or `Email rejected by provider (permanent)` (bad key/payload — fix
   `MAIL_FROM`/key). Message bodies and the API key are never logged, so grep by
   `to`/`subject`, not content.
3. **Invalid config crashes boot.** `RESEND_API_KEY` set without a valid
   `MAIL_FROM` fails validation — the API won't start. Fix and restart.

Password reset and invites both fall back to a usable path: a reset link is only
sent (not shown), but an invite still returns its URL in the API response for
manual sharing.

## Database issues

`/health/ready` = `503`, or requests failing with connection errors.

```bash
# Can the runtime role connect at all?
psql "$DATABASE_URL_APP" -c "select 1;"
# Is the owner URL reachable (for migrations)?
psql "$DATABASE_URL" -c "select 1;"
```

- **Connection refused / timeout** — Neon endpoint down, wrong host, or a
  network/SSL issue. In production both URLs need `sslmode=verify-full`.
- **`permission denied` from the app but not the owner** — the `oraos_api` grants
  are missing (a new table without the default-privilege grant, or the role
  password wasn't set). Re-run the app-role provisioning
  ([DEPLOYMENT.md](DEPLOYMENT.md)).
- **Every tenant sees another tenant's data** — the app is connecting as the
  **owner** (BYPASSRLS). `DATABASE_URL_APP` must be the `oraos_api` role and must
  differ from `DATABASE_URL`; the app refuses to boot if they're equal, so this
  means the URLs were swapped in the secret store. Fix immediately.

## Migration failures

Migrations run in a **separate one-shot step before** the API starts (compose:
the `migrate` service; the API waits for it to succeed).

```bash
docker compose logs migrate                 # what failed
docker compose run --rm migrate             # re-run migrations manually
# Direct (platform deploy):
DATABASE_URL="<owner url>" pnpm --filter @oraos/api db:migrate:deploy
```

- A failed migration leaves the API **not started** (it depends on `migrate`
  completing) — you are not serving against a half-migrated schema.
- Every migration must be backward-compatible with the previous app version, so
  a migration that lands before the new code does not break the old code still
  running (zero-downtime rule).
- If a migration is bad, **roll the migration forward with a fix** — do not edit
  an applied migration. To recover data state, see
  [BACKUP_RESTORE.md](BACKUP_RESTORE.md).

## Restoring service (fast triage)

1. `docker compose ps` — which service is unhealthy?
2. `GET /health` and `/health/ready` — process vs database.
3. `docker compose logs --since=15m <service>` — find the first error and its
   request id.
4. If a bad **deploy**: roll back to the previous image/commit
   ([DEPLOYMENT.md → Rollback](DEPLOYMENT.md#rollback)).
5. If the **database**: confirm the DB is reachable; if data is corrupt, follow
   the [recovery checklist](BACKUP_RESTORE.md#recovery-checklist).
6. Confirm green: both health endpoints `200`, a real login + one write succeed.
