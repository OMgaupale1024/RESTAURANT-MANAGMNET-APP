-- AlterEnum
ALTER TYPE "order_event_type" ADD VALUE 'REFUND_RECORDED';

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "method" "payment_method" NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_user_id" UUID,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refunds_order_id_idx" ON "refunds"("order_id");

-- CreateIndex
CREATE INDEX "refunds_restaurant_id_created_at_idx" ON "refunds"("restaurant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_restaurant_id_idempotency_key_key" ON "refunds"("restaurant_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Tenant isolation — same policy as every tenant-scoped table.
-- ===========================================================================
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON refunds;
CREATE POLICY tenant_isolation ON refunds
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

-- A refund returns money; zero or negative would be a payment in disguise.
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_amount_positive;
ALTER TABLE refunds ADD CONSTRAINT refunds_amount_positive
  CHECK (amount_minor > 0);

-- ===========================================================================
-- Money handed back is an immutable financial record. Corrections are new
-- rows (a compensating payment), never an edit — same rule as payments,
-- coupon_redemptions and the stock ledger.
-- ===========================================================================
DROP TRIGGER IF EXISTS refunds_append_only ON refunds;
CREATE TRIGGER refunds_append_only
  BEFORE UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

REVOKE UPDATE, DELETE ON refunds FROM oraos_api;
