-- CreateEnum
CREATE TYPE "stock_unit" AS ENUM ('GRAM', 'MILLILITRE', 'PIECE');

-- CreateEnum
CREATE TYPE "stock_movement_type" AS ENUM ('PURCHASE', 'CONSUMPTION', 'WASTE', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "ingredients" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "unit" "stock_unit" NOT NULL,
    "reorder_level" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "type" "stock_movement_type" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "order_id" UUID,
    "note" TEXT,
    "actor_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_items" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipe_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingredients_restaurant_id_is_active_idx" ON "ingredients"("restaurant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "ingredients_restaurant_id_name_key" ON "ingredients"("restaurant_id", "name");

-- CreateIndex
CREATE INDEX "stock_movements_restaurant_id_ingredient_id_created_at_idx" ON "stock_movements"("restaurant_id", "ingredient_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_order_id_idx" ON "stock_movements"("order_id");

-- CreateIndex
CREATE INDEX "recipe_items_restaurant_id_idx" ON "recipe_items"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_items_product_id_ingredient_id_key" ON "recipe_items"("product_id", "ingredient_id");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- RLS
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ingredients', 'stock_movements', 'recipe_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (restaurant_id = current_restaurant_id())
         WITH CHECK (restaurant_id = current_restaurant_id())', t);
  END LOOP;
END $$;

-- ===========================================================================
-- The stock ledger is append-only, same discipline as order_events.
-- ===========================================================================
--
-- Without this, "correcting" stock by editing history would be possible, and
-- the ledger would stop being able to answer where the cheese went. A mistake
-- is corrected by appending an ADJUSTMENT, never by rewriting the past.
DROP TRIGGER IF EXISTS stock_movements_append_only ON stock_movements;
CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

REVOKE UPDATE, DELETE ON stock_movements FROM oraos_api;

-- A zero-quantity movement is noise in a ledger: it records that nothing
-- happened.
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_quantity_nonzero;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_quantity_nonzero
  CHECK (quantity <> 0);

-- Direction is part of a movement's meaning, not a convention to remember.
-- PURCHASE that removes stock, or WASTE that adds it, is always a bug.
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_direction;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_direction
  CHECK (
    (type = 'PURCHASE'    AND quantity > 0) OR
    (type = 'CONSUMPTION' AND quantity < 0) OR
    (type = 'WASTE'       AND quantity < 0) OR
    (type = 'ADJUSTMENT')
  );

-- A recipe consuming zero or negative of an ingredient is meaningless.
ALTER TABLE recipe_items DROP CONSTRAINT IF EXISTS recipe_items_quantity_positive;
ALTER TABLE recipe_items ADD CONSTRAINT recipe_items_quantity_positive
  CHECK (quantity > 0);

ALTER TABLE ingredients DROP CONSTRAINT IF EXISTS ingredients_reorder_non_negative;
ALTER TABLE ingredients ADD CONSTRAINT ingredients_reorder_non_negative
  CHECK (reorder_level IS NULL OR reorder_level >= 0);
