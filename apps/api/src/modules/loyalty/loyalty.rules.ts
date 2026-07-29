import { LoyaltyEntryType } from '../../generated/prisma/enums';

/**
 * The loyalty POLICY, isolated from the ledger MECHANISM. Everything here is a
 * pure function of its inputs — no database, no request context — which is what
 * lets a future milestone (campaigns, bonus multipliers, per-tenant tiers)
 * change the rules without touching how points are stored.
 *
 * This is the "rules engine": a seam, deliberately NOT a pluggable DSL or a
 * rules table. When earning becomes per-tenant configurable, EARN_RATE becomes
 * a lookup and TIERS a table read — and no caller changes, because they already
 * depend only on these functions.
 */

/** Net spend that earns one point. 1000 paise = ₹10 per point. */
export const EARN_RATE_MINOR_PER_POINT = 1000;

/**
 * Points earned for an order, from its NET sale value (subtotal − discount).
 * Tax is excluded on purpose: a customer is rewarded for what they spent with
 * the restaurant, not for the GST it merely collects. Integer floor, never
 * round — points can never outrun the value that earned them.
 */
export function pointsForOrder(order: {
  subtotalMinor: number;
  discountMinor: number;
}): number {
  const net = order.subtotalMinor - order.discountMinor;
  if (net <= 0) return 0;
  return Math.floor(net / EARN_RATE_MINOR_PER_POINT);
}

/**
 * The tier ladder, ascending. Lifetime EARNED points — not the spendable
 * balance — decides status, so redeeming points never costs a customer their
 * tier. Code-defined for the foundation; a per-tenant `loyalty_tiers` table is
 * the documented extension, and `tierFor` is the only thing that changes.
 */
export const TIERS = [
  { key: 'BRONZE', label: 'Bronze', minPoints: 0 },
  { key: 'SILVER', label: 'Silver', minPoints: 1000 },
  { key: 'GOLD', label: 'Gold', minPoints: 5000 },
  { key: 'PLATINUM', label: 'Platinum', minPoints: 20000 },
] as const;

export type Tier = (typeof TIERS)[number];

/** The highest tier whose threshold the lifetime-earned points have reached. */
export function tierFor(lifetimeEarnedPoints: number): Tier {
  let current: Tier = TIERS[0];
  for (const t of TIERS) {
    if (lifetimeEarnedPoints >= t.minPoints) current = t;
  }
  return current;
}

/** The next tier up and how far away it is, or null once at the top. */
export function nextTierFor(lifetimeEarnedPoints: number): {
  key: string;
  label: string;
  minPoints: number;
  pointsToGo: number;
} | null {
  const next = TIERS.find((t) => t.minPoints > lifetimeEarnedPoints);
  if (!next) return null;
  return { ...next, pointsToGo: next.minPoints - lifetimeEarnedPoints };
}

/**
 * Which entry types count toward lifetime-earned (and therefore tier). Earning,
 * its refund reversal, and manual adjustments all move status; spending
 * (REDEEM) and lapsing (EXPIRE) do not.
 */
export const STATUS_TYPES: LoyaltyEntryType[] = [
  LoyaltyEntryType.EARN,
  LoyaltyEntryType.REFUND_REVERSAL,
  LoyaltyEntryType.ADJUST,
];
