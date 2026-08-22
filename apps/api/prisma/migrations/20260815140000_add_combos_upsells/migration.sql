-- CreateTable: combos (a bundle sold as one line at its own price).
CREATE TABLE "combos" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "category_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_minor" INTEGER NOT NULL,
    "tax_rate_bp" INTEGER NOT NULL DEFAULT 500,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_popular" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "combos_pkey" PRIMARY KEY ("id")
);

-- CreateTable: a combo's component products.
CREATE TABLE "combo_items" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "combo_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "combo_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable: "after X was added, suggest Y" (one suggestion, at Y's price).
CREATE TABLE "upsell_rules" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "trigger_product_id" UUID NOT NULL,
    "suggested_product_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upsell_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "combos_restaurant_id_is_active_idx" ON "combos"("restaurant_id", "is_active");
CREATE UNIQUE INDEX "combos_restaurant_id_name_key" ON "combos"("restaurant_id", "name");
CREATE INDEX "combo_items_restaurant_id_combo_id_idx" ON "combo_items"("restaurant_id", "combo_id");
CREATE INDEX "upsell_rules_restaurant_id_trigger_product_id_idx" ON "upsell_rules"("restaurant_id", "trigger_product_id");
CREATE UNIQUE INDEX "upsell_rules_restaurant_id_trigger_product_id_suggested_pro_key" ON "upsell_rules"("restaurant_id", "trigger_product_id", "suggested_product_id");

-- AddForeignKey
ALTER TABLE "combos" ADD CONSTRAINT "combos_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "combo_items" ADD CONSTRAINT "combo_items_combo_id_fkey" FOREIGN KEY ("combo_id") REFERENCES "combos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "combo_items" ADD CONSTRAINT "combo_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "upsell_rules" ADD CONSTRAINT "upsell_rules_trigger_product_id_fkey" FOREIGN KEY ("trigger_product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "upsell_rules" ADD CONSTRAINT "upsell_rules_suggested_product_id_fkey" FOREIGN KEY ("suggested_product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: immutable component snapshot on a combo order line. Set => the
-- line is a combo. Its cost is the combo's own price in unit_price_minor, so
-- the existing order_items_amounts_valid CHECK (line_total = unit_price * qty)
-- still holds.
ALTER TABLE "order_items" ADD COLUMN "combo_items" JSONB;

-- Money + rule integrity at the database, not just the app.
ALTER TABLE combos ADD CONSTRAINT combos_price_valid
  CHECK (price_minor >= 0 AND tax_rate_bp >= 0);
ALTER TABLE combo_items ADD CONSTRAINT combo_items_quantity_positive
  CHECK (quantity >= 1);
-- No self-upsell: a product may never suggest itself.
ALTER TABLE upsell_rules ADD CONSTRAINT upsell_rules_not_self
  CHECK (trigger_product_id <> suggested_product_id);

-- ===========================================================================
-- Tenant isolation — the standard policy on every tenant-scoped table. All
-- three are MUTABLE menu config, so like modifier_groups there is no
-- append-only trigger; what a customer actually bought is snapshotted onto
-- order_items (name + price + combo_items). The app role (oraos_api) gets CRUD
-- automatically via the ALTER DEFAULT PRIVILEGES in 20260717080000_add_app_role.
-- ===========================================================================
ALTER TABLE combos ENABLE ROW LEVEL SECURITY;
ALTER TABLE combos FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON combos;
CREATE POLICY tenant_isolation ON combos
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

ALTER TABLE combo_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE combo_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON combo_items;
CREATE POLICY tenant_isolation ON combo_items
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

ALTER TABLE upsell_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE upsell_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON upsell_rules;
CREATE POLICY tenant_isolation ON upsell_rules
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
