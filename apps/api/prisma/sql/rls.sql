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
