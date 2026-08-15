-- Prep inventory: prepared ingredients are made in the kitchen from raw ones and
-- stocked in batches, all on the EXISTING stock ledger. New tables:
-- prep_recipe_items (a prepared item's raw components) and prep_batches (one
-- preparation event). New columns extend ingredients (prep flags) and
-- stock_movements (prep_batch_id). No second inventory — see schema notes.

-- AlterTable: prep flags on ingredients. All nullable/defaulted, so existing
-- rows are untouched (every current ingredient stays a raw, non-prepared item).
ALTER TABLE "ingredients" ADD COLUMN "is_prepared" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ingredients" ADD COLUMN "prep_batch_yield" INTEGER;
ALTER TABLE "ingredients" ADD COLUMN "prep_shelf_life_hours" INTEGER;

-- AlterTable: tag a ledger row with the prep batch it belongs to. Nullable; a
-- raw purchase/sale carries none. No FK — the ledger outlives everything, same
-- as order_id / supplier_id.
ALTER TABLE "stock_movements" ADD COLUMN "prep_batch_id" UUID;

-- CreateTable: a prepared item's recipe — its raw components, per standard batch.
CREATE TABLE "prep_recipe_items" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "prep_ingredient_id" UUID NOT NULL,
    "component_ingredient_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prep_recipe_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable: one preparation event. Its stock effects (raw out, prepared in,
-- later draw-down) live in stock_movements tagged with this id.
CREATE TABLE "prep_batches" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "prep_ingredient_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "expected_quantity" INTEGER NOT NULL,
    "actual_quantity" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3),
    "cost_minor" INTEGER,
    "note" TEXT,
    "actor_user_id" UUID,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prep_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_movements_prep_batch_id_idx" ON "stock_movements"("prep_batch_id");
CREATE UNIQUE INDEX "prep_recipe_items_prep_component_key" ON "prep_recipe_items"("prep_ingredient_id", "component_ingredient_id");
CREATE INDEX "prep_recipe_items_restaurant_id_prep_ingredient_id_idx" ON "prep_recipe_items"("restaurant_id", "prep_ingredient_id");
CREATE UNIQUE INDEX "prep_batches_restaurant_id_code_key" ON "prep_batches"("restaurant_id", "code");
CREATE UNIQUE INDEX "prep_batches_restaurant_id_idempotency_key_key" ON "prep_batches"("restaurant_id", "idempotency_key");
CREATE INDEX "prep_batches_restaurant_id_prep_ingredient_id_created_at_idx" ON "prep_batches"("restaurant_id", "prep_ingredient_id", "created_at");

-- AddForeignKey
ALTER TABLE "prep_recipe_items" ADD CONSTRAINT "prep_recipe_items_prep_ingredient_id_fkey" FOREIGN KEY ("prep_ingredient_id") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prep_recipe_items" ADD CONSTRAINT "prep_recipe_items_component_ingredient_id_fkey" FOREIGN KEY ("component_ingredient_id") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prep_batches" ADD CONSTRAINT "prep_batches_prep_ingredient_id_fkey" FOREIGN KEY ("prep_ingredient_id") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Extend the ledger direction CHECK: prep consumption removes stock, prep output
-- adds it. Same discipline as PURCHASE/CONSUMPTION/WASTE — direction is meaning,
-- not a convention to remember. (The enum values were added in the prior
-- migration; they are committed before this CHECK references them.)
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_direction;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_direction
  CHECK (
    (type = 'PURCHASE'    AND quantity > 0) OR
    (type = 'CONSUMPTION' AND quantity < 0) OR
    (type = 'WASTE'       AND quantity < 0) OR
    (type = 'ADJUSTMENT') OR
    (type = 'PREP_BATCH'  AND quantity < 0) OR
    (type = 'PREP_OUTPUT' AND quantity > 0)
  );

-- Prep recipe/batch integrity at the database, not just the app.
-- A component quantity of zero or less is meaningless (mirrors recipe_items).
ALTER TABLE prep_recipe_items ADD CONSTRAINT prep_recipe_items_quantity_positive
  CHECK (quantity > 0);
-- A prepared item may never be a component of itself.
ALTER TABLE prep_recipe_items ADD CONSTRAINT prep_recipe_items_not_self
  CHECK (prep_ingredient_id <> component_ingredient_id);
-- Yields and cost are non-negative amounts.
ALTER TABLE prep_batches ADD CONSTRAINT prep_batches_quantities_valid
  CHECK (expected_quantity >= 0 AND actual_quantity >= 0 AND (cost_minor IS NULL OR cost_minor >= 0));

-- ===========================================================================
-- Tenant isolation — the standard policy on every tenant-scoped table. Both are
-- MUTABLE menu/prep config (like modifier_groups / combos), so no append-only
-- trigger; the immutable record of what was prepared and consumed lives in the
-- append-only stock_movements. The app role (oraos_api) gets CRUD via the
-- ALTER DEFAULT PRIVILEGES in 20260717080000_add_app_role.
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['prep_recipe_items', 'prep_batches'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (restaurant_id = current_restaurant_id())
         WITH CHECK (restaurant_id = current_restaurant_id())', t);
  END LOOP;
END $$;
