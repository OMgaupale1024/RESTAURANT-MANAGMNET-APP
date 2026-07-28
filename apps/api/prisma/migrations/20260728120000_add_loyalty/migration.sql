-- CreateEnum
CREATE TYPE "loyalty_entry_type" AS ENUM ('EARN', 'REDEEM', 'ADJUST', 'REFUND_REVERSAL', 'EXPIRE');

-- CreateTable
CREATE TABLE "loyalty_ledger" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "type" "loyalty_entry_type" NOT NULL,
    "points" INTEGER NOT NULL,
    "order_id" UUID,
    "reason" TEXT,
    "actor_user_id" UUID,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loyalty_ledger_restaurant_id_customer_id_created_at_idx" ON "loyalty_ledger"("restaurant_id", "customer_id", "created_at");

-- CreateIndex
CREATE INDEX "loyalty_ledger_order_id_idx" ON "loyalty_ledger"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_ledger_restaurant_id_idempotency_key_key" ON "loyalty_ledger"("restaurant_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Tenant isolation — same policy as every tenant-scoped table.
-- ===========================================================================
ALTER TABLE loyalty_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON loyalty_ledger;
CREATE POLICY tenant_isolation ON loyalty_ledger
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

-- The sign of a points entry is tied to its kind: a credit is positive, a debit
-- negative, a manual adjustment non-zero either way. Catches a wrong-signed
-- write at the source, the way orders_total_adds_up catches a bad total.
ALTER TABLE loyalty_ledger DROP CONSTRAINT IF EXISTS loyalty_ledger_points_sign;
ALTER TABLE loyalty_ledger ADD CONSTRAINT loyalty_ledger_points_sign
  CHECK (
    (type = 'EARN' AND points > 0)
    OR (type IN ('REDEEM', 'EXPIRE', 'REFUND_REVERSAL') AND points < 0)
    OR (type = 'ADJUST' AND points <> 0)
  );

-- At most one EARN and one REFUND_REVERSAL per order: a sale earns its points
-- once, and those points are reversed once. This is the ledger-level guarantee
-- behind earnForOrder/reverseForOrder being idempotent — a retried call loses
-- the unique race and reads back the existing row instead of double-crediting.
-- Manual entries (adjust/redeem) carry no order_id and are unconstrained here.
DROP INDEX IF EXISTS loyalty_ledger_order_type_unique;
CREATE UNIQUE INDEX loyalty_ledger_order_type_unique
  ON loyalty_ledger (restaurant_id, order_id, type)
  WHERE order_id IS NOT NULL;

-- ===========================================================================
-- Points are money-adjacent: an immutable record. Corrections are new rows (an
-- ADJUST, a REFUND_REVERSAL), never an edit — same rule as payments, refunds,
-- coupon_redemptions and the stock ledger.
-- ===========================================================================
DROP TRIGGER IF EXISTS loyalty_ledger_append_only ON loyalty_ledger;
CREATE TRIGGER loyalty_ledger_append_only
  BEFORE UPDATE OR DELETE ON loyalty_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

REVOKE UPDATE, DELETE ON loyalty_ledger FROM oraos_api;
