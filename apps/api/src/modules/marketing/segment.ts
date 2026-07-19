/**
 * Deterministic customer segmentation — the single source of truth.
 *
 * Both MarketingService (segment counts and per-segment customer lists) and
 * CustomersService (the segment on a customer's profile) classify through this
 * one pure function, so a customer can never land in one segment on the
 * marketing screen and another on their own profile.
 *
 * Thresholds are constants, not settings — a per-restaurant tuning UI would be
 * a settings concern that does not exist yet. Every rule is stated back to the
 * caller (SEGMENT_META) so a segment is never a black box.
 */

export const SEGMENT_THRESHOLDS = {
  VIP_MIN_VISITS: 5,
  VIP_MIN_SPENT_MINOR: 500_000, // ₹5,000
  REGULAR_MIN_VISITS: 3,
  LAPSED_AFTER_DAYS: 30,
} as const;

export type SegmentKey = 'VIP' | 'REGULAR' | 'NEW' | 'LAPSED';

export const SEGMENT_KEYS: readonly SegmentKey[] = [
  'VIP',
  'REGULAR',
  'NEW',
  'LAPSED',
];

export const SEGMENT_META: Record<SegmentKey, { label: string; rule: string }> =
  {
    VIP: {
      label: 'VIP',
      rule: `${SEGMENT_THRESHOLDS.VIP_MIN_VISITS}+ visits and ${SEGMENT_THRESHOLDS.VIP_MIN_SPENT_MINOR / 100}+ spent`,
    },
    REGULAR: {
      label: 'Regular',
      rule: `${SEGMENT_THRESHOLDS.REGULAR_MIN_VISITS}+ visits`,
    },
    NEW: { label: 'New', rule: 'Fewer visits, seen recently' },
    LAPSED: {
      label: 'Lapsed',
      rule: `No visit in ${SEGMENT_THRESHOLDS.LAPSED_AFTER_DAYS} days`,
    },
  };

/**
 * Classifies one purchasing customer into exactly one segment. Inputs are the
 * non-void order stats (the same exclusion used everywhere money is counted).
 * Recency wins first: a lapsed VIP is a win-back target, not a VIP to reward.
 */
export function classifySegment(
  stats: { visits: number; spentMinor: number; lastVisit: Date | null },
  now: Date = new Date(),
): SegmentKey {
  const {
    VIP_MIN_VISITS,
    VIP_MIN_SPENT_MINOR,
    REGULAR_MIN_VISITS,
    LAPSED_AFTER_DAYS,
  } = SEGMENT_THRESHOLDS;
  const lapsedCutoff = new Date(now.getTime() - LAPSED_AFTER_DAYS * 86_400_000);

  if (stats.lastVisit && stats.lastVisit < lapsedCutoff) return 'LAPSED';
  if (stats.visits >= VIP_MIN_VISITS && stats.spentMinor >= VIP_MIN_SPENT_MINOR)
    return 'VIP';
  if (stats.visits >= REGULAR_MIN_VISITS) return 'REGULAR';
  return 'NEW';
}
