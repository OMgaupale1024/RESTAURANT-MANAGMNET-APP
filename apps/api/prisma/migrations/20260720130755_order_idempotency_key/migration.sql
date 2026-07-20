-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "idempotency_key" TEXT;

-- CreateIndex
-- Unique per tenant. Postgres does not treat NULLs as equal, so the orders
-- that already exist (and any future order sent without a key) do not collide.
CREATE UNIQUE INDEX "orders_restaurant_id_idempotency_key_key" ON "orders"("restaurant_id", "idempotency_key");
