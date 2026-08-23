-- AlterTable: archive flag on customers. Existing rows default to true (every
-- customer stays active). Archived customers are hidden from the CRM list but
-- never deleted — their orders and loyalty ledger must survive, and the POS
-- phone lookup still finds them so a returning customer is not duplicated.
-- The customers table already has RLS enabled; a new column inherits the
-- table's policies, so no policy change is required.
ALTER TABLE "customers" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
