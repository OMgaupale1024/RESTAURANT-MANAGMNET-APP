# Backup & Recovery

The data that matters lives in Postgres (Neon). Everything else — images,
config — is reproducible from git and the secret store. This document is the
plan for getting the data back, and the proof that the plan works.

> An untested backup is not a backup (BLUEPRINT §8). The restore drill below is
> the point of this document.

## Backup strategy

| What | Where | Mechanism | Cadence |
|---|---|---|---|
| Postgres data | Neon | **Point-in-time restore (PITR)** — continuous WAL | Continuous |
| Schema / migrations | git (`apps/api/prisma/migrations`) | Version control | Every change |
| Secrets | Secret manager | Provider-managed | On rotation |
| Container images | Registry (optional) or rebuilt from git | CI / `docker build` | Per release |

There is **no application-level dump** because Neon PITR is continuous and
authoritative. If you self-host Postgres instead of Neon, replace PITR with
`pg_dump` on a schedule plus WAL archiving, and keep the rest of this document
as-is.

## Neon PITR

Neon retains a continuous history and lets you restore to any instant within the
retention window (branch-based — the restore lands in a **new branch**, so the
live database is never overwritten by mistake).

Restore, at a high level (via the Neon console or API):

1. Create a branch from the target timestamp (just before the incident).
2. Point a **scratch** connection string at that branch.
3. Verify the data (below) before touching production.
4. Promote the branch, or copy the needed rows back, only once verified.

Keep the retention window longer than your worst realistic detection time for
data corruption (days, not hours).

## Restore verification (the drill)

Run this on a schedule (e.g. monthly) and after any change to the DB topology.
It restores into a scratch branch and confirms the data is intact **without
touching production**.

```bash
# 1. Create a Neon branch from a recent timestamp; get its connection string.
export SCRATCH_URL="postgresql://owner:...@<branch-host>/neondb?sslmode=verify-full"

# 2. Sanity: schema is present and migrations are all applied.
psql "$SCRATCH_URL" -c "\dt"                      # tables exist
psql "$SCRATCH_URL" -c "select count(*) from _prisma_migrations;"

# 3. Sanity: core data survived and RLS is still in place.
psql "$SCRATCH_URL" -c "select count(*) from restaurants;"
psql "$SCRATCH_URL" -c "select count(*) from orders;"
psql "$SCRATCH_URL" -c "select relname, relrowsecurity from pg_class
  where relname in ('orders','payments','memberships');"   # rowsecurity = t

# 4. Optional end-to-end: point a staging API at $SCRATCH_URL (as owner) plus a
#    scratch oraos_api role, hit /health/ready, and do one read through the app.

# 5. Record the result (date, timestamp restored, row counts, pass/fail).
#    Discard the scratch branch.
```

A drill that is not recorded did not happen. Keep a short log of each run.

## Recovery checklist

When production data is wrong (corruption, a bad migration, an erroneous mass
update):

- [ ] **Stop the bleeding.** If a bad deploy is still writing, roll it back
      first ([DEPLOYMENT.md → Rollback](DEPLOYMENT.md#rollback)).
- [ ] **Fix the time of the incident.** Find the first bad write (audit logs,
      `security_events`, app logs by request id).
- [ ] **Restore to a scratch branch** at a timestamp just before that.
- [ ] **Verify** the scratch branch with the drill steps above.
- [ ] **Decide the reconciliation:** full cutover to the branch, or selective
      copy of the affected rows back into production. Prefer selective copy if
      good writes happened after the incident.
- [ ] **Apply**, then re-verify: both health endpoints green, a real read/write
      through the app succeeds.
- [ ] **Write it up.** What happened, the timestamp restored, what was copied,
      and one change that would have prevented it.

## Disaster recovery (total loss)

Losing the whole running environment (region, project, or account) is recovered
from three independent sources — git, the secret store, and Neon:

1. **Provision a database.** New Neon project (or restore the project from Neon's
   backups); apply schema with `pnpm --filter @oraos/api db:migrate:deploy` and
   provision the `oraos_api` role (`db:setup-app-role --print`).
2. **Restore data** into it via PITR / branch, verified as above.
3. **Rebuild and deploy** the API and web images from git (`docker compose up -d
   --build`, or the platform build). No image registry is required — everything
   builds from source.
4. **Reconfigure secrets** from the secret manager (`JWT_SECRET`, DB URLs, mail).
   Rotating `JWT_SECRET` during DR is fine — it just signs everyone out.
5. **Repoint DNS** to the new API/web hosts (see
   [DEPLOYMENT.md](DEPLOYMENT.md)).
6. **Verify green** end-to-end and record the RTO/RPO actually achieved.

Recovery time is bounded by DB restore + image build + DNS propagation. The
application layer is stateless and disposable by design.
