# Release Checklist

Run through this before promoting OraOS to production. Each box is verifiable —
if you cannot demonstrate it, it is not done. References point at the doc that
explains the how.

## Pre-deploy

- [ ] **Environment configured** — every required variable set in the secret
      store; `DATABASE_URL_APP ≠ DATABASE_URL`; email + `APP_VERSION` set.
      ([ENVIRONMENT.md](ENVIRONMENT.md))
- [ ] **Secrets are real and unique** — `JWT_SECRET` ≥32 chars generated fresh;
      `oraos_api` password provisioned via `db:setup-app-role --print`; no `.env`
      committed. ([SECURITY.md](SECURITY.md))
- [ ] **HTTPS enabled** — web and API served over TLS; `CORS_ORIGINS` and
      `WEB_URL` are `https://`; DB URLs use `sslmode=verify-full`.
      ([DEPLOYMENT.md](DEPLOYMENT.md#https-and-reverse-proxy))
- [ ] **Domains are same-site** — e.g. `app.example.com` + `api.example.com`, so
      the `SameSite=Strict` refresh cookie is delivered.
- [ ] **CI passing** on the release commit — lint, typecheck, unit + e2e, both
      app builds, both docker builds green. (GitHub Actions)
- [ ] **Docker images built** — `docker compose build` (or the platform build)
      succeeds for API and web. ([DEPLOYMENT.md](DEPLOYMENT.md#docker))

## Deploy

- [ ] **Migrations run** — `migrate` step completed successfully **before** the
      API started; every migration is backward-compatible.
      ([DEPLOYMENT.md](DEPLOYMENT.md#deploy-sequence), [RUNBOOK.md](RUNBOOK.md#migration-failures))
- [ ] **Startup order honoured** — migrate → api → web; the API only starts after
      migrations succeed.
- [ ] **Deployment verified** — the running commit/image matches what was
      intended; `GET /health` reports the expected `version`.

## Post-deploy (green checks)

- [ ] **Health endpoint green** — `GET /api/v1/health` → `200` with status,
      uptime, version, timestamp.
- [ ] **Readiness endpoint green** — `GET /api/v1/health/ready` → `200
      {ready, database:up}`.
- [ ] **Email configured & working** — a real password-reset request produces a
      delivered email (not just a log line). ([RUNBOOK.md](RUNBOOK.md#email-issues))
- [ ] **Monitoring verified** — structured logs flowing with request ids;
      redaction confirmed (no tokens/cookies in logs); slow-request warnings
      visible; external error alerting wired or explicitly accepted as a gap.
- [ ] **Backups configured** — Neon PITR retention set; a **restore drill** has
      been run and recorded. ([BACKUP_RESTORE.md](BACKUP_RESTORE.md))
- [ ] **Rollback rehearsed** — you know how to roll back the deploy and the
      migration path. ([DEPLOYMENT.md](DEPLOYMENT.md#rollback))

## Smoke test (real flows)

- [ ] Register / log in → dashboard loads; reload keeps the session (refresh
      cookie works).
- [ ] Create a restaurant, take one order (a real write through RLS succeeds).
- [ ] Invite a staff member → invite email arrives → accept → scoped session.
- [ ] Forgot password → reset link → new password works, old sessions revoked.
- [ ] Sign out everywhere → the other session can no longer refresh.

## Sign-off

- [ ] Owner has read [SECURITY.md](SECURITY.md) operational recommendations and
      accepted any open items (error alerting, per-recipient reset throttling,
      credential-stuffing defence) as known, tracked gaps.
- [ ] Release tagged; `APP_VERSION` set to that tag/SHA.
