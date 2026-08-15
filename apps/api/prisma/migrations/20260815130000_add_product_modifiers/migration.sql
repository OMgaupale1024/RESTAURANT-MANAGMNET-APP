-- CreateTable: modifier groups (Style / Quantity / Add-ons ...) per product.
CREATE TABLE "modifier_groups" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "min_select" INTEGER NOT NULL DEFAULT 0,
    "max_select" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable: the options within a group, each with a price adjustment.
CREATE TABLE "modifier_options" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_adjust_minor" INTEGER NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "modifier_options_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "modifier_groups_restaurant_id_product_id_idx" ON "modifier_groups"("restaurant_id", "product_id");
CREATE INDEX "modifier_options_restaurant_id_group_id_idx" ON "modifier_options"("restaurant_id", "group_id");

-- AddForeignKey
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "modifier_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: immutable snapshot of chosen modifiers on each sold line. Cost is
-- baked into unit_price_minor, so the existing order_items_amounts_valid CHECK
-- (line_total_minor = unit_price_minor * quantity) still holds unchanged.
ALTER TABLE "order_items" ADD COLUMN "modifiers" JSONB;

-- Selection-rule and price integrity, enforced by the database — not just the app.
ALTER TABLE modifier_groups ADD CONSTRAINT modifier_groups_select_valid
  CHECK (min_select >= 0 AND max_select >= 1 AND min_select <= max_select);
ALTER TABLE modifier_options ADD CONSTRAINT modifier_options_price_valid
  CHECK (price_adjust_minor >= 0);

-- ===========================================================================
-- Tenant isolation — same policy as every tenant-scoped table. Both tables are
-- MUTABLE (owners edit the menu config), so like menu_import_sessions there is
-- deliberately no append-only trigger; the permanent record of what a customer
-- ordered lives in the immutable order_items.modifiers snapshot. The app role
-- (oraos_api) receives CRUD automatically via the ALTER DEFAULT PRIVILEGES set
-- in 20260717080000_add_app_role.
-- ===========================================================================
ALTER TABLE modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifier_groups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON modifier_groups;
CREATE POLICY tenant_isolation ON modifier_groups
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

ALTER TABLE modifier_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifier_options FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON modifier_options;
CREATE POLICY tenant_isolation ON modifier_options
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
