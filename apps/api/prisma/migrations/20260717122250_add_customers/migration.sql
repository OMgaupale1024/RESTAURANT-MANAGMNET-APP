-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "customer_id" UUID;

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "birthday" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_restaurant_id_name_idx" ON "customers"("restaurant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "customers_restaurant_id_phone_key" ON "customers"("restaurant_id", "phone");

-- CreateIndex
CREATE INDEX "orders_customer_id_idx" ON "orders"("customer_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- RLS: customers is PII, so this is the boundary that matters most so far.
-- ===========================================================================
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON customers;
CREATE POLICY tenant_isolation ON customers
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

-- Phone is stored digits-only and normalised in the application. The CHECK
-- makes that a guarantee rather than a habit: without it, "+91 98765 43210"
-- and "9876543210" become two customers who are one person, and the per-tenant
-- unique index silently stops meaning anything.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_phone_digits;
ALTER TABLE customers ADD CONSTRAINT customers_phone_digits
  CHECK (phone ~ '^[0-9]{7,15}$');

-- Email stored lowercase, same rationale as users.email.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_email_lowercase;
ALTER TABLE customers ADD CONSTRAINT customers_email_lowercase
  CHECK (email IS NULL OR email = lower(email));
