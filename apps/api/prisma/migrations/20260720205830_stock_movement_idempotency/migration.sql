-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "idempotency_key" TEXT;

-- CreateIndex
-- Unique per tenant. Postgres does not treat NULLs as equal, so existing
-- movements and every server-written CONSUMPTION/reversal (no key) do not collide.
CREATE UNIQUE INDEX "stock_movements_restaurant_id_idempotency_key_key" ON "stock_movements"("restaurant_id", "idempotency_key");
