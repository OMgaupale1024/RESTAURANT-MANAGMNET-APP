-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('DRAFT', 'PLACED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED', 'VOIDED');

-- CreateEnum
CREATE TYPE "order_event_type" AS ENUM ('CREATED', 'STATUS_CHANGED', 'ITEM_ADDED', 'ITEM_REMOVED', 'PAYMENT_RECORDED', 'NOTE_ADDED');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CASH', 'UPI', 'CARD', 'WALLET', 'OTHER');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'CAPTURED', 'FAILED');

-- CreateTable
CREATE TABLE "restaurants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "branch_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "metadata" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_number" INTEGER NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'DRAFT',
    "subtotal_minor" INTEGER NOT NULL,
    "discount_minor" INTEGER NOT NULL DEFAULT 0,
    "tax_minor" INTEGER NOT NULL,
    "total_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "notes" TEXT,
    "placed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID,
    "name_snapshot" TEXT NOT NULL,
    "unit_price_minor" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "line_total_minor" INTEGER NOT NULL,
    "tax_rate_bp" INTEGER NOT NULL,
    "tax_minor" INTEGER NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "type" "order_event_type" NOT NULL,
    "from_status" "order_status",
    "to_status" "order_status",
    "actor_user_id" UUID,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "method" "payment_method" NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "amount_minor" INTEGER NOT NULL,
    "reference" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "restaurants_slug_key" ON "restaurants"("slug");

-- CreateIndex
CREATE INDEX "branches_restaurant_id_idx" ON "branches"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "branches_restaurant_id_name_key" ON "branches"("restaurant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "memberships_restaurant_id_idx" ON "memberships"("restaurant_id");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_restaurant_id_key" ON "memberships"("user_id", "restaurant_id");

-- CreateIndex
CREATE INDEX "audit_logs_restaurant_id_created_at_idx" ON "audit_logs"("restaurant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_restaurant_id_entity_type_entity_id_idx" ON "audit_logs"("restaurant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "orders_restaurant_id_created_at_idx" ON "orders"("restaurant_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_restaurant_id_status_idx" ON "orders"("restaurant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_restaurant_id_order_number_key" ON "orders"("restaurant_id", "order_number");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_restaurant_id_idx" ON "order_items"("restaurant_id");

-- CreateIndex
CREATE INDEX "order_events_order_id_created_at_idx" ON "order_events"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "order_events_restaurant_id_created_at_idx" ON "order_events"("restaurant_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- CreateIndex
CREATE INDEX "payments_restaurant_id_created_at_idx" ON "payments"("restaurant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_restaurant_id_idempotency_key_key" ON "payments"("restaurant_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Appended from prisma/sql/rls.sql — RLS, CHECK constraints, append-only.
-- Kept in the same migration so tables can never exist without protection.
-- ===========================================================================

-- Invariants Prisma's schema language cannot express.
-- Appended to the initial migration. Idempotent so it can be re-run safely.
--
-- Three things live here:
--   1. Row-Level Security  — the actual tenant boundary (BLUEPRINT §4, layer 3)
--   2. CHECK constraints   — money arithmetic and data shape
--   3. Append-only triggers — audit_logs and order_events cannot be rewritten

-- ===========================================================================
-- 1. Row-Level Security
-- ===========================================================================
--
-- The app sets `app.restaurant_id` per transaction (SET LOCAL). Policies read
-- it back. current_setting(..., true) returns NULL when unset rather than
-- raising, and `restaurant_id = NULL` is NULL, which is not true — so an
-- unset tenant context returns zero rows and blocks every insert.
-- It fails closed. That is the point.
--
-- FORCE is essential: without it the table OWNER bypasses RLS silently, and
-- the app connects as the owner today. FORCE subjects the owner to policies too.

CREATE OR REPLACE FUNCTION current_restaurant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.restaurant_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;

-- Tenant root: keyed on id, not restaurant_id.
ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON restaurants;
CREATE POLICY tenant_isolation ON restaurants
  USING (id = current_restaurant_id())
  WITH CHECK (id = current_restaurant_id());

-- Standard tenant-scoped tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'branches', 'audit_logs', 'orders', 'order_items', 'order_events', 'payments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (restaurant_id = current_restaurant_id())
         WITH CHECK (restaurant_id = current_restaurant_id())', t);
  END LOOP;
END $$;

-- memberships is the exception, and deliberately so.
--
-- Login is a chicken-and-egg problem: before we know which restaurant the user
-- belongs to, we must read their memberships — but tenant context does not
-- exist yet. So a user may always read their OWN memberships (which also powers
-- the restaurant switcher), and a tenant may read memberships belonging to it.
-- Both sides are still bounded; there is no path to reading a stranger's rows.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON memberships;
CREATE POLICY tenant_isolation ON memberships
  USING (
    restaurant_id = current_restaurant_id()
    OR user_id = current_user_id()
  )
  WITH CHECK (restaurant_id = current_restaurant_id());

-- users, roles, permissions, role_permissions are intentionally NOT
-- tenant-scoped. users is global identity (one human, many restaurants);
-- the other three are global reference data. Access is controlled in the
-- application layer, not by RLS, because they have no tenant to key on.

-- ===========================================================================
-- 2. CHECK constraints
-- ===========================================================================

-- Email stored lowercase, so the unique index is effectively
-- case-insensitive. Cheaper than the citext extension and equally enforced.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_lowercase;
ALTER TABLE users ADD CONSTRAINT users_email_lowercase
  CHECK (email = lower(email));

-- Money: no negatives anywhere, and the total must actually add up.
-- This is the constraint that catches a rounding or discount bug at write
-- time rather than in a GST filing.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_amounts_non_negative;
ALTER TABLE orders ADD CONSTRAINT orders_amounts_non_negative
  CHECK (subtotal_minor >= 0 AND discount_minor >= 0
         AND tax_minor >= 0 AND total_minor >= 0);

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_total_adds_up;
ALTER TABLE orders ADD CONSTRAINT orders_total_adds_up
  CHECK (total_minor = subtotal_minor - discount_minor + tax_minor);

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_discount_within_subtotal;
ALTER TABLE orders ADD CONSTRAINT orders_discount_within_subtotal
  CHECK (discount_minor <= subtotal_minor);

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_quantity_positive;
ALTER TABLE order_items ADD CONSTRAINT order_items_quantity_positive
  CHECK (quantity > 0);

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_amounts_valid;
ALTER TABLE order_items ADD CONSTRAINT order_items_amounts_valid
  CHECK (unit_price_minor >= 0 AND tax_minor >= 0
         AND tax_rate_bp >= 0 AND tax_rate_bp <= 10000
         AND line_total_minor = unit_price_minor * quantity);

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_amount_positive;
ALTER TABLE payments ADD CONSTRAINT payments_amount_positive
  CHECK (amount_minor > 0);

-- ===========================================================================
-- 3. Append-only enforcement
-- ===========================================================================
--
-- A trigger, not a GRANT. Grants do not bind the table owner, and the app
-- currently connects as the owner; a trigger binds everyone short of someone
-- with rights to drop the trigger itself.

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

DROP TRIGGER IF EXISTS order_events_append_only ON order_events;
CREATE TRIGGER order_events_append_only
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
