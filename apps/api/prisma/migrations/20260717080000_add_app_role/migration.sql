-- Least-privilege application role.
--
-- WHY THIS EXISTS (learned the hard way, verified by prisma/verify-rls.ts):
-- Neon's default role `neondb_owner` carries the BYPASSRLS attribute. With it,
-- every RLS policy is silently ignored — ENABLE and even FORCE ROW LEVEL
-- SECURITY make no difference whatsoever. FORCE defends against the *owner*
-- exemption; it does not touch BYPASSRLS.
--
-- The result is the worst possible failure mode: a database that looks
-- protected, reports policies in pg_policies, and enforces nothing.
--
-- So the app must NOT connect as the owner. It connects as oraos_api, which
-- has no BYPASSRLS and is therefore actually subject to the policies.
--
--   DATABASE_URL      -> neondb_owner, migrations only (DDL)
--   DATABASE_URL_APP  -> oraos_api, all application runtime queries
--
-- The password is not set here — migrations are committed to git. It is set
-- out of band by prisma/setup-app-role.ts, which writes it to .env only.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oraos_api') THEN
    -- NOLOGIN until a password is set out of band. NOBYPASSRLS is the default
    -- but stated explicitly: it is the entire point of this role.
    CREATE ROLE oraos_api NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT CONNECT ON DATABASE neondb TO oraos_api;
GRANT USAGE ON SCHEMA public TO oraos_api;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oraos_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO oraos_api;

-- Append-only, enforced twice: the trigger stops everyone, and the missing
-- grant means the app cannot even attempt it. Defence in depth, because the
-- trigger is one DROP TRIGGER away from gone.
REVOKE UPDATE, DELETE ON audit_logs FROM oraos_api;
REVOKE UPDATE, DELETE ON order_events FROM oraos_api;

-- Migration history is not application data. The app has no business reading
-- or writing it. Guarded: the table may not exist yet depending on when
-- Prisma creates it relative to this migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
  ) THEN
    REVOKE ALL ON _prisma_migrations FROM oraos_api;
  END IF;
END $$;

-- Tables created by future migrations must inherit these grants automatically,
-- or every new table silently becomes unreachable to the app.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oraos_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO oraos_api;
