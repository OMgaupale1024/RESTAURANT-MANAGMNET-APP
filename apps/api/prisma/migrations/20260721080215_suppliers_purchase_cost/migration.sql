-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "supplier_id" UUID,
ADD COLUMN     "total_cost_minor" INTEGER;

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppliers_restaurant_id_is_active_idx" ON "suppliers"("restaurant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_restaurant_id_name_key" ON "suppliers"("restaurant_id", "name");

-- ===========================================================================
-- Tenant isolation for suppliers — same policy as every tenant-scoped table.
-- ===========================================================================
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON suppliers;
CREATE POLICY tenant_isolation ON suppliers
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

-- A purchase cost is money: it cannot be negative. (Null when a receive was
-- recorded without a cost — the ingredient simply has no cost basis yet.)
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_cost_non_negative;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_cost_non_negative
  CHECK (total_cost_minor IS NULL OR total_cost_minor >= 0);
