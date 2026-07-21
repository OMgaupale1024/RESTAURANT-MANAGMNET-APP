-- CreateEnum
CREATE TYPE "cash_session_type" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "cash_movement_type" AS ENUM ('PAY_IN', 'PAY_OUT');

-- CreateTable
CREATE TABLE "cash_sessions" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "status" "cash_session_type" NOT NULL DEFAULT 'OPEN',
    "opening_float_minor" INTEGER NOT NULL,
    "opened_by_user_id" UUID NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_by_user_id" UUID,
    "closed_at" TIMESTAMP(3),
    "closing_counted_minor" INTEGER,
    "expected_cash_minor" INTEGER,
    "variance_minor" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "type" "cash_movement_type" NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_sessions_restaurant_id_opened_at_idx" ON "cash_sessions"("restaurant_id", "opened_at");

-- CreateIndex
CREATE INDEX "cash_movements_session_id_idx" ON "cash_movements"("session_id");

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Tenant isolation — same policy as every tenant-scoped table.
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cash_sessions', 'cash_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (restaurant_id = current_restaurant_id())
         WITH CHECK (restaurant_id = current_restaurant_id())', t);
  END LOOP;
END $$;

-- At most one OPEN session per tenant. This is what lets the settlement scope
-- its takings by the session's time window unambiguously — two open drawers
-- would make "cash sales since open" meaningless.
CREATE UNIQUE INDEX cash_sessions_one_open_per_tenant
  ON cash_sessions (restaurant_id) WHERE status = 'OPEN';

-- A float and a non-sale movement are magnitudes; the sign comes from the type.
ALTER TABLE cash_sessions DROP CONSTRAINT IF EXISTS cash_sessions_float_non_negative;
ALTER TABLE cash_sessions ADD CONSTRAINT cash_sessions_float_non_negative
  CHECK (opening_float_minor >= 0);
ALTER TABLE cash_movements DROP CONSTRAINT IF EXISTS cash_movements_amount_positive;
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_amount_positive
  CHECK (amount_minor > 0);

-- Cash movements are an immutable trail. A mistake is corrected by an opposing
-- movement, never an edit — same rule as payments, refunds and the ledger.
DROP TRIGGER IF EXISTS cash_movements_append_only ON cash_movements;
CREATE TRIGGER cash_movements_append_only
  BEFORE UPDATE OR DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

REVOKE UPDATE, DELETE ON cash_movements FROM oraos_api;
