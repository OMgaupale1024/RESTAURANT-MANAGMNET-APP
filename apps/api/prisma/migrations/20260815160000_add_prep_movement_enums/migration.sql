-- AlterEnum: prepared-inventory movement types.
--
-- These live in their OWN migration on purpose. PostgreSQL forbids USING a new
-- enum value in the same transaction that ADDs it, and the next migration
-- (20260815160100_add_prep_inventory) references both in the extended
-- stock_movements_direction CHECK. Splitting the ADD from the USE — the same
-- pattern as 20260730120000/…120100 for REDEEM_REVERSAL — keeps both migrations
-- applyable in one `migrate deploy`.
ALTER TYPE "stock_movement_type" ADD VALUE 'PREP_BATCH';
ALTER TYPE "stock_movement_type" ADD VALUE 'PREP_OUTPUT';
