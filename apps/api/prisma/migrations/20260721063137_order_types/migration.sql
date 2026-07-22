-- CreateEnum
CREATE TYPE "order_type" AS ENUM ('DINE_IN', 'TAKEAWAY', 'DELIVERY');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "order_type" "order_type" NOT NULL DEFAULT 'TAKEAWAY';
