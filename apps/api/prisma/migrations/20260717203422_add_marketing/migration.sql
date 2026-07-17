-- CreateEnum
CREATE TYPE "coupon_type" AS ENUM ('PERCENT', 'FIXED');

-- CreateTable
CREATE TABLE "coupons" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "type" "coupon_type" NOT NULL,
    "percent_bp" INTEGER,
    "amount_minor" INTEGER,
    "max_discount_minor" INTEGER,
    "min_subtotal_minor" INTEGER NOT NULL DEFAULT 0,
    "max_redemptions" INTEGER,
    "valid_from" TIMESTAMP(3),
    "valid_until" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_redemptions" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "coupon_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "discount_minor" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coupons_restaurant_id_is_active_idx" ON "coupons"("restaurant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_restaurant_id_code_key" ON "coupons"("restaurant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_redemptions_order_id_key" ON "coupon_redemptions"("order_id");

-- CreateIndex
CREATE INDEX "coupon_redemptions_restaurant_id_coupon_id_idx" ON "coupon_redemptions"("restaurant_id", "coupon_id");

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- RLS
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['coupons', 'coupon_redemptions'] LOOP
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
-- Coupon value integrity — a coupon must be exactly one kind of discount, and
-- the numbers must make sense. The database refuses a malformed coupon rather
-- than trusting the app to have validated it.
-- ===========================================================================
ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_value_shape;
ALTER TABLE coupons ADD CONSTRAINT coupons_value_shape CHECK (
  (type = 'PERCENT' AND percent_bp IS NOT NULL AND percent_bp > 0 AND percent_bp <= 10000 AND amount_minor IS NULL)
  OR
  (type = 'FIXED' AND amount_minor IS NOT NULL AND amount_minor > 0 AND percent_bp IS NULL)
);

ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_non_negative;
ALTER TABLE coupons ADD CONSTRAINT coupons_non_negative CHECK (
  min_subtotal_minor >= 0
  AND (max_discount_minor IS NULL OR max_discount_minor > 0)
  AND (max_redemptions IS NULL OR max_redemptions > 0)
);

-- A validity window must not be inverted.
ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_valid_window;
ALTER TABLE coupons ADD CONSTRAINT coupons_valid_window CHECK (
  valid_from IS NULL OR valid_until IS NULL OR valid_until > valid_from
);

-- A redemption records money given away; it cannot be negative.
ALTER TABLE coupon_redemptions DROP CONSTRAINT IF EXISTS coupon_redemptions_discount_positive;
ALTER TABLE coupon_redemptions ADD CONSTRAINT coupon_redemptions_discount_positive
  CHECK (discount_minor > 0);

-- ===========================================================================
-- Redemptions are an immutable financial record, like every other money trail.
-- The discount that was given cannot be edited or erased after the fact.
-- ===========================================================================
DROP TRIGGER IF EXISTS coupon_redemptions_append_only ON coupon_redemptions;
CREATE TRIGGER coupon_redemptions_append_only
  BEFORE UPDATE OR DELETE ON coupon_redemptions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

REVOKE UPDATE, DELETE ON coupon_redemptions FROM oraos_api;
