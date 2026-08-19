-- Stock counts: a physical count reconciled into the EXISTING stock ledger.
-- A count snapshots system stock at start (stock_count_lines.system_quantity),
-- staff enter what they physically counted, and on submit each non-zero
-- discrepancy becomes ONE signed ADJUSTMENT stock_movement — the movement type
-- that has always meant "a stock count correcting reality". No second
-- adjustment ledger and no mutable stock counter: this is the workflow around a
-- primitive that already exists. New enums + two mutable tables only; nothing on
-- stock_movements changes (the ADJUSTMENT rows carry the count code in `note`).

-- CreateEnum: brand-new types (not ALTER TYPE on stock_movement_type), so a
-- single migration is safe — the "cannot use a new enum value in the same
-- transaction that adds it" rule only bites ALTER TYPE ... ADD VALUE.
CREATE TYPE "stock_count_status" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');
CREATE TYPE "stock_count_reason" AS ENUM ('WASTE_SPOILAGE', 'COUNTING_ERROR', 'DAMAGED', 'THEFT', 'UNRECORDED_USAGE', 'RECEIVING_DISCREPANCY', 'OTHER');

-- CreateTable: one physical-count session.
CREATE TABLE "stock_counts" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" "stock_count_status" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "created_by" UUID,
    "submitted_by" UUID,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable: one ingredient on a count. counted/difference/reason fill in on
-- submit; the ADJUSTMENT effect on stock lives in stock_movements, not here.
CREATE TABLE "stock_count_lines" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "stock_count_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "system_quantity" INTEGER NOT NULL,
    "counted_quantity" INTEGER,
    "difference" INTEGER,
    "reason" "stock_count_reason",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_counts_restaurant_id_code_key" ON "stock_counts"("restaurant_id", "code");
CREATE INDEX "stock_counts_restaurant_id_status_idx" ON "stock_counts"("restaurant_id", "status");
CREATE UNIQUE INDEX "stock_count_lines_stock_count_id_ingredient_id_key" ON "stock_count_lines"("stock_count_id", "ingredient_id");
CREATE INDEX "stock_count_lines_restaurant_id_stock_count_id_idx" ON "stock_count_lines"("restaurant_id", "stock_count_id");

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_stock_count_id_fkey" FOREIGN KEY ("stock_count_id") REFERENCES "stock_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A physical count can never be negative (§15). The API rejects it too; the DB
-- is the backstop, same discipline as stock_movements_quantity_nonzero.
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_counted_non_negative"
  CHECK ("counted_quantity" IS NULL OR "counted_quantity" >= 0);

-- ===========================================================================
-- Tenant isolation — the standard policy on every tenant-scoped table. Both are
-- MUTABLE (a count fills in and moves OPEN → COMPLETED), so like purchase_orders
-- and prep there is no append-only trigger and no REVOKE: the immutable record
-- is the append-only stock_movements the submit writes plus the stockcount.*
-- audit-log event. The app role (oraos_api) keeps CRUD via the ALTER DEFAULT
-- PRIVILEGES in 20260717080000_add_app_role.
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_counts', 'stock_count_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (restaurant_id = current_restaurant_id())
         WITH CHECK (restaurant_id = current_restaurant_id())', t);
  END LOOP;
END $$;
