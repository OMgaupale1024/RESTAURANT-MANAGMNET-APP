import { LoyaltyEntryType } from '../../generated/prisma/enums';

/**
 * The loyalty POLICY, isolated from the ledger MECHANISM. Everything here is a
 * pure function of its inputs — no database, no request context — which is what
 * lets the rules change (per-tenant configuration, M13) without touching how
 * points are stored.
 *
 * M13 made earning and redemption CONFIGURABLE per tenant. The rates are no
 * longer constants: every rule below takes a `LoyaltyConfig`, which the service
 * loads from the `loyalty_settings` row (falling back to DEFAULT_LOYALTY_CONFIG
 * when a tenant has never touched it — the legacy ₹10/point earn, ₹1/point
 * redeem, so behaviour is unchanged until an owner changes it).
 *
 * Money is paise (integer minor units) throughout; points are whole integers.
 * Never floating-point currency.
 */

/** A tenant's loyalty rules — mirrors the loyalty_settings row (all minor units). */
export type LoyaltyConfig = {
  isEnabled: boolean;
  /** Spend (paise) that earns `earnPoints`. e.g. 10000 (₹100) → 10 points. */
  earnAmountMinor: number;
  earnPoints: number;
  /** `redeemPoints` are worth `redeemAmountMinor` off. e.g. 100 pts → 5000 (₹50). */
  redeemPoints: number;
  redeemAmountMinor: number;
  /** Fewest points a single redemption may spend. 0 = no floor. */
  minimumRedeemPoints: number;
  /** Most points one order may redeem, or null for no ceiling. */
  maximumRedeemPointsPerOrder: number | null;
};

/**
 * The rules a tenant gets before ever opening the settings screen. These
 * reproduce the pre-M13 hardcoded behaviour EXACTLY — 1 point per ₹10 net spent,
 * ₹1 per redeemed point, any amount redeemable — so every existing tenant keeps
 * the same loyalty until an owner deliberately changes it.
 */
export const DEFAULT_LOYALTY_CONFIG: LoyaltyConfig = {
  isEnabled: true,
  earnAmountMinor: 1000, // ₹10
  earnPoints: 1,
  redeemPoints: 1,
  redeemAmountMinor: 100, // ₹1 per point
  minimumRedeemPoints: 0,
  maximumRedeemPointsPerOrder: null,
};

/** The earn-rate slice stored on an EARN row so it stays explainable forever. */
export function earnSnapshot(c: LoyaltyConfig) {
  return { earnAmountMinor: c.earnAmountMinor, earnPoints: c.earnPoints };
}

/** The redeem-rate slice stored on a REDEEM row so it stays explainable forever. */
export function redeemSnapshot(c: LoyaltyConfig) {
  return {
    redeemPoints: c.redeemPoints,
    redeemAmountMinor: c.redeemAmountMinor,
  };
}

/**
 * Points earned for an order, from its NET sale value (subtotal − discount).
 * Tax is excluded on purpose: a customer is rewarded for what they spent with
 * the restaurant, not for the GST it merely collects.
 *
 * ROUNDING (documented, deterministic): points = floor(net × earnPoints ÷
 * earnAmountMinor), computed in integer paise. At the default ₹10/point a ₹480
 * net order earns floor(48000 × 1 ÷ 1000) = 48. This floors at the POINT, not at
 * the earn block, and never lets points outrun the value that earned them.
 * Earning is off entirely when loyalty is disabled.
 */
export function pointsForOrder(
  order: { subtotalMinor: number; discountMinor: number },
  config: LoyaltyConfig,
): number {
  if (!config.isEnabled) return 0;
  const net = order.subtotalMinor - order.discountMinor;
  if (net <= 0) return 0;
  return Math.floor((net * config.earnPoints) / config.earnAmountMinor);
}

/** A validated redemption, or the reason it was refused (surfaced verbatim). */
export type RedemptionResult =
  | { ok: true; points: number; discountMinor: number }
  | { ok: false; reason: string };

/**
 * Validate a point redemption against the config and price it, WITHOUT trusting
 * any client-supplied discount. Points are redeemed in configured blocks
 * (multiples of `redeemPoints`), never arbitrary amounts, so a mis-tap can't
 * spend an odd number. An over-large redemption is REFUSED, not silently capped
 * (M13 §14): the cashier must pick a reward the order can actually use, so a
 * customer is never quietly charged points for a discount larger than the bill.
 * The caller enforces the balance under a lock; this is pure.
 */
export function redemptionFor(
  points: number,
  subtotalMinor: number,
  config: LoyaltyConfig,
): RedemptionResult {
  if (!config.isEnabled) return { ok: false, reason: 'Loyalty is turned off' };
  if (!Number.isInteger(points) || points <= 0) {
    return { ok: false, reason: 'Enter a whole number of points to redeem' };
  }
  if (points % config.redeemPoints !== 0) {
    return {
      ok: false,
      reason: `Redeem points in multiples of ${config.redeemPoints}`,
    };
  }
  if (points < config.minimumRedeemPoints) {
    return {
      ok: false,
      reason: `Redeem at least ${config.minimumRedeemPoints} points`,
    };
  }
  if (
    config.maximumRedeemPointsPerOrder !== null &&
    points > config.maximumRedeemPointsPerOrder
  ) {
    return {
      ok: false,
      reason: `Redeem at most ${config.maximumRedeemPointsPerOrder} points per order`,
    };
  }
  const discountMinor =
    (points / config.redeemPoints) * config.redeemAmountMinor;
  if (discountMinor <= 0) {
    return { ok: false, reason: 'These points are worth no discount' };
  }
  if (discountMinor > subtotalMinor) {
    return { ok: false, reason: 'The order is too small for this reward' };
  }
  return { ok: true, points, discountMinor };
}

/**
 * The smallest reward a customer can actually claim right now — the one the POS
 * shows as "100 pts → ₹50 [Apply]". It is the smallest valid block (at least the
 * configured minimum) that the balance can afford and the per-order maximum
 * allows. Null when loyalty is off or the balance is short.
 */
export function availableReward(
  balancePoints: number,
  config: LoyaltyConfig,
): { points: number; discountMinor: number } | null {
  if (!config.isEnabled || config.redeemPoints <= 0) return null;
  const floor = Math.max(config.redeemPoints, config.minimumRedeemPoints);
  const points = Math.ceil(floor / config.redeemPoints) * config.redeemPoints;
  if (points <= 0 || balancePoints < points) return null;
  if (
    config.maximumRedeemPointsPerOrder !== null &&
    points > config.maximumRedeemPointsPerOrder
  ) {
    return null;
  }
  const discountMinor =
    (points / config.redeemPoints) * config.redeemAmountMinor;
  if (discountMinor <= 0) return null;
  return { points, discountMinor };
}

/**
 * Validate a proposed configuration, returning the first problem or null. The DB
 * has CHECK constraints as a backstop; this gives the owner a clear message and
 * catches the nonsensical-but-technically-valid cases (M13 §5). The sanity
 * bounds — at most one point per paise earned, a point worth at most ₹100 —
 * catch fat-finger mistakes like "₹1 = 1,000,000 points" without imposing a real
 * business limit on any sane rate.
 */
export function validateConfig(c: LoyaltyConfig): string | null {
  if (!Number.isInteger(c.earnAmountMinor) || c.earnAmountMinor <= 0) {
    return 'Spend amount must be a whole number greater than zero';
  }
  if (!Number.isInteger(c.earnPoints) || c.earnPoints <= 0) {
    return 'Earned points must be a whole number greater than zero';
  }
  if (!Number.isInteger(c.redeemPoints) || c.redeemPoints <= 0) {
    return 'Redeem points must be a whole number greater than zero';
  }
  if (!Number.isInteger(c.redeemAmountMinor) || c.redeemAmountMinor < 0) {
    return 'Redeem value cannot be negative';
  }
  if (!Number.isInteger(c.minimumRedeemPoints) || c.minimumRedeemPoints < 0) {
    return 'Minimum redemption cannot be negative';
  }
  if (
    c.maximumRedeemPointsPerOrder !== null &&
    (!Number.isInteger(c.maximumRedeemPointsPerOrder) ||
      c.maximumRedeemPointsPerOrder < 0)
  ) {
    return 'Maximum redemption cannot be negative';
  }
  // Sanity: no more than one point per paise (≤ 100 points per ₹).
  if (c.earnPoints > c.earnAmountMinor) {
    return 'That earn rate is unusually high — check the amounts';
  }
  // Sanity: a point worth at most ₹100.
  if (c.redeemAmountMinor > c.redeemPoints * 10000) {
    return 'That redeem value is unusually high — check the amounts';
  }
  if (c.minimumRedeemPoints % c.redeemPoints !== 0) {
    return 'Minimum redemption must be a multiple of the redeem points';
  }
  if (c.maximumRedeemPointsPerOrder !== null) {
    if (c.maximumRedeemPointsPerOrder % c.redeemPoints !== 0) {
      return 'Maximum redemption must be a multiple of the redeem points';
    }
    if (c.maximumRedeemPointsPerOrder < c.minimumRedeemPoints) {
      return 'Maximum redemption must be at least the minimum';
    }
  }
  return null;
}

/**
 * The tier ladder, ascending. Lifetime EARNED points — not the spendable
 * balance — decides status, so redeeming points never costs a customer their
 * tier. Tiers are deliberately code-defined and OUT OF M13's scope (configurable
 * tiers were explicitly excluded); this stays exactly as the loyalty foundation
 * shipped it.
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
