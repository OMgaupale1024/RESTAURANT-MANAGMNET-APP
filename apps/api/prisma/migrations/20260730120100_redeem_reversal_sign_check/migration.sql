-- Extend the points-sign CHECK: a REDEEM_REVERSAL is a credit (points > 0),
-- like EARN. Runs in a separate migration/transaction from the ADD VALUE, so
-- PostgreSQL permits referencing the new enum value here.
ALTER TABLE loyalty_ledger DROP CONSTRAINT IF EXISTS loyalty_ledger_points_sign;
ALTER TABLE loyalty_ledger ADD CONSTRAINT loyalty_ledger_points_sign
  CHECK (
    (type IN ('EARN', 'REDEEM_REVERSAL') AND points > 0)
    OR (type IN ('REDEEM', 'EXPIRE', 'REFUND_REVERSAL') AND points < 0)
    OR (type = 'ADJUST' AND points <> 0)
  );

-- No new index: the partial unique index (restaurant_id, order_id, type) WHERE
-- order_id IS NOT NULL already guarantees at most one REDEEM_REVERSAL per order
-- — the same idempotency EARN and REFUND_REVERSAL rely on.
