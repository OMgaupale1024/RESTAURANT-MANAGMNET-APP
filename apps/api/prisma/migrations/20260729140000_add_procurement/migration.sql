-- CreateEnum
CREATE TYPE "purchase_order_status" AS ENUM ('DRAFT', 'ORDERED', 'RECEIVED', 'CANCELLED');

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN "is_preferred" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "status" "purchase_order_status" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "actor_user_id" UUID,
    "ordered_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "total_cost_minor" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_orders_restaurant_id_status_idx" ON "purchase_orders"("restaurant_id", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_restaurant_id_supplier_id_idx" ON "purchase_orders"("restaurant_id", "supplier_id");

-- CreateIndex
CREATE INDEX "purchase_order_items_restaurant_id_idx" ON "purchase_order_items"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_items_purchase_order_id_ingredient_id_key" ON "purchase_order_items"("purchase_order_id", "ingredient_id");

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Tenant isolation — the same policy as every tenant-scoped table. These tables
-- are MUTABLE (a PO's status and its draft items change), so unlike the money
-- ledgers there is deliberately no append-only trigger and no REVOKE: the app
-- role keeps the full CRUD it receives by default privilege. The audit trail of
-- what actually happened lives in the immutable stock_movements a receipt writes
-- and the po.* events recorded via EventsService.
-- ===========================================================================
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON purchase_orders;
CREATE POLICY tenant_isolation ON purchase_orders
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON purchase_order_items;
CREATE POLICY tenant_isolation ON purchase_order_items
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
