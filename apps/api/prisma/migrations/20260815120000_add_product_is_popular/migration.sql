-- AlterTable: "Popular" merchandising flag on products. Existing rows default
-- to false (nothing is popular until an owner marks it). The products table
-- already has RLS enabled; a new column inherits the table's policies, so no
-- policy change is required.
ALTER TABLE "products" ADD COLUMN "is_popular" BOOLEAN NOT NULL DEFAULT false;
