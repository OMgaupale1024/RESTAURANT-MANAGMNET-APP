-- M11 Loyalty Redemption. A refund restores redeemed points as a POSITIVE,
-- balance-only entry (deliberately NOT a status type — it must not inflate
-- lifetime-earned or tier). The symmetric counterpart to REFUND_REVERSAL.
--
-- The enum value is added in its OWN migration because PostgreSQL forbids USING
-- a newly added enum value in the same transaction that added it. The sign
-- CHECK that references it lives in the next migration.
ALTER TYPE "loyalty_entry_type" ADD VALUE IF NOT EXISTS 'REDEEM_REVERSAL';
