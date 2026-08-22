-- Configurable loyalty (M13): per-tenant earn/redeem rules + an on/off switch,
-- plus a per-row config snapshot so history stays explainable after a rule
-- change. Additive only — the loyalty ledger and every balance are untouched.

-- Historical integrity: the rule in force when an EARN/REDEEM row was written,
-- frozen on the row. Nullable and additive; existing rows keep NULL (their
-- points already encode the result under the legacy rate). loyalty_ledger is
-- append-only via trigger, but ADD COLUMN is DDL, not a row write.
ALTER TABLE "loyalty_ledger" ADD COLUMN "config_snapshot" JSONB;

-- CreateTable: one loyalty configuration per restaurant. Defaults reproduce the
-- pre-M13 hardcoded behaviour (₹10/point earn, ₹1/point redeem, no floor/ceiling),
-- so a tenant that never opens the settings screen is unaffected.
CREATE TABLE "loyalty_settings" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "earn_amount_minor" INTEGER NOT NULL DEFAULT 1000,
    "earn_points" INTEGER NOT NULL DEFAULT 1,
    "redeem_points" INTEGER NOT NULL DEFAULT 1,
    "redeem_amount_minor" INTEGER NOT NULL DEFAULT 100,
    "minimum_redeem_points" INTEGER NOT NULL DEFAULT 0,
    "maximum_redeem_points_per_order" INTEGER,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loyalty_settings_pkey" PRIMARY KEY ("id")
);

-- One configuration per tenant.
CREATE UNIQUE INDEX "loyalty_settings_restaurant_id_key" ON "loyalty_settings"("restaurant_id");

-- Value constraints — the DB backstop behind LoyaltyService.validateConfig. A
-- ratio must be usable (earn amount/points and redeem points strictly positive),
-- values non-negative, and the earn rate sane (at most one point per paise, which
-- rejects fat-finger rates like "₹1 = 1,000,000 points" — M13 §5).
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_earn_amount_positive"
  CHECK ("earn_amount_minor" > 0);
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_earn_points_positive"
  CHECK ("earn_points" > 0 AND "earn_points" <= "earn_amount_minor");
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_redeem_points_positive"
  CHECK ("redeem_points" > 0);
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_redeem_amount_non_negative"
  CHECK ("redeem_amount_minor" >= 0);
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_minimum_non_negative"
  CHECK ("minimum_redeem_points" >= 0);
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_maximum_non_negative"
  CHECK ("maximum_redeem_points_per_order" IS NULL OR "maximum_redeem_points_per_order" >= 0);

-- ===========================================================================
-- Tenant isolation — the standard policy on every tenant-scoped table. Mutable
-- (owner-editable), so like stock_counts there is no append-only trigger; the
-- immutable trail is the loyalty.settings_updated audit event plus each ledger
-- row's configSnapshot. The app role (oraos_api) keeps CRUD via the ALTER
-- DEFAULT PRIVILEGES in 20260717080000_add_app_role.
-- ===========================================================================
ALTER TABLE "loyalty_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "loyalty_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "loyalty_settings";
CREATE POLICY tenant_isolation ON "loyalty_settings"
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
