-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "category_id" UUID,
    "name" TEXT NOT NULL,
    "price_minor" INTEGER NOT NULL,
    "tax_rate_bp" INTEGER NOT NULL DEFAULT 500,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "categories_restaurant_id_idx" ON "categories"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_restaurant_id_name_key" ON "categories"("restaurant_id", "name");

-- CreateIndex
CREATE INDEX "products_restaurant_id_is_active_idx" ON "products"("restaurant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "products_restaurant_id_name_key" ON "products"("restaurant_id", "name");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- RLS for the catalogue (same discipline as every tenant-scoped table)
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['categories', 'products'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (restaurant_id = current_restaurant_id())
         WITH CHECK (restaurant_id = current_restaurant_id())', t);
  END LOOP;
END $$;

-- Money sanity, enforced by the database rather than by remembering.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_price_valid;
ALTER TABLE products ADD CONSTRAINT products_price_valid
  CHECK (price_minor >= 0 AND tax_rate_bp >= 0 AND tax_rate_bp <= 10000);

-- ===========================================================================
-- Backlog #6: orders are append-only in the ways that matter
-- ===========================================================================
--
-- The blueprint says "never UPDATE a completed order's totals". Blanket
-- revoking UPDATE would break the status transitions that Orders (Step 11) and
-- Kitchen (Step 15) need, so the rule is enforced precisely instead:
--
--   1. Orders/items/payments can never be DELETEd by the app. Corrections are
--      new rows (void, refund), never erasure.
--   2. Once an order leaves DRAFT, its money columns are frozen. Status may
--      still move; totals may not.
--
-- This is what "append-only" actually means for this table.

REVOKE DELETE ON orders FROM oraos_api;
REVOKE DELETE ON order_items FROM oraos_api;
REVOKE DELETE ON payments FROM oraos_api;

CREATE OR REPLACE FUNCTION freeze_order_money() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A draft is still being built; anything else is a financial record.
  IF OLD.status <> 'DRAFT' AND (
       NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor OR
       NEW.discount_minor IS DISTINCT FROM OLD.discount_minor OR
       NEW.tax_minor      IS DISTINCT FROM OLD.tax_minor      OR
       NEW.total_minor    IS DISTINCT FROM OLD.total_minor    OR
       NEW.currency       IS DISTINCT FROM OLD.currency
     ) THEN
    RAISE EXCEPTION
      'order % is placed: totals are immutable (status=%)', OLD.id, OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_freeze_money ON orders;
CREATE TRIGGER orders_freeze_money
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION freeze_order_money();

-- Line items of a placed order are equally frozen: editing a line would
-- desync the order total that the CHECK constraint guarantees.
CREATE OR REPLACE FUNCTION freeze_placed_order_items() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM orders WHERE id = COALESCE(NEW.order_id, OLD.order_id);
  IF s IS NOT NULL AND s <> 'DRAFT' THEN
    RAISE EXCEPTION 'order items are immutable once the order is placed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_items_freeze ON order_items;
CREATE TRIGGER order_items_freeze
  BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION freeze_placed_order_items();
