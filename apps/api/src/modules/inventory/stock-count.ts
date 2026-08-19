/**
 * Stock-count maths, kept pure and tested. Like prep.ts, none of this touches
 * the database or the clock (callers pass `now` / the live-stock map), so every
 * rule below — how a physical count becomes a ledger adjustment, when a reason
 * is required, the human count code — is exercised by stock-count.spec.ts
 * without a DB.
 *
 * Every quantity is an integer in the ingredient's base unit (grams /
 * millilitres / pieces), exactly like the rest of inventory.
 */

/** The controlled reasons a discrepancy can carry (mirrors the DB enum). */
export type CountReason =
  | 'WASTE_SPOILAGE'
  | 'COUNTING_ERROR'
  | 'DAMAGED'
  | 'THEFT'
  | 'UNRECORDED_USAGE'
  | 'RECEIVING_DISCREPANCY'
  | 'OTHER';

/** One physical count a staff member entered. */
export type SubmitLine = {
  ingredientId: string;
  /** Non-negative (the DTO enforces it), in the ingredient's base unit. */
  countedQuantity: number;
  reason: CountReason | null;
};

/** A reconciled count line: the adjustment to append, signed. */
export type CountAdjustment = {
  ingredientId: string;
  countedQuantity: number;
  /** counted − live stock. The ADJUSTMENT movement to write (0 ⇒ nothing). */
  difference: number;
  reason: CountReason | null;
};

/**
 * Turn physical counts into signed ledger adjustments, reconciled against the
 * LIVE stock at submit time.
 *
 * The adjustment is `counted − liveStock`, NEVER `counted − snapshot`. Reading
 * the live ledger (SUM of movements *now*) means any sale, purchase or prep
 * that happened while staff were counting is already reflected, so the
 * adjustment corrects only the genuine, unexplained gap. A naive
 * `counted − snapshot` would double-count a legitimate mid-count sale — writing
 * a 3kg correction where only 1kg went missing (§5, §6). The snapshot taken at
 * the start is kept for display and the audit record; it is deliberately not
 * the basis of the maths.
 *
 * An ingredient with no ledger rows is zero stock, not an error.
 */
export function reconcileCount(
  lines: SubmitLine[],
  liveStock: Map<string, number>,
): CountAdjustment[] {
  return lines.map((l) => ({
    ingredientId: l.ingredientId,
    countedQuantity: l.countedQuantity,
    difference: l.countedQuantity - (liveStock.get(l.ingredientId) ?? 0),
    reason: l.reason,
  }));
}

/**
 * The ingredients whose adjustment is non-zero but carries no reason. A zero
 * difference needs no reason (nothing changed); anything else does (§12), so the
 * "why did stock move" is never blank on the record.
 */
export function missingReasons(adjustments: CountAdjustment[]): string[] {
  return adjustments
    .filter((a) => a.difference !== 0 && a.reason === null)
    .map((a) => a.ingredientId);
}

/**
 * A human count code, SC-YYMMDD-XXXX. The uuid is the real key; this is just a
 * label staff can read out, and mirrors prep's batchCode exactly. `suffix` is
 * injectable so the format is testable.
 */
export function countCode(
  now: Date,
  suffix: string = Math.random().toString(36).slice(2, 6).toUpperCase(),
): string {
  const y = String(now.getUTCFullYear()).slice(2);
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `SC-${y}${m}${d}-${suffix.toUpperCase().padStart(4, '0').slice(0, 4)}`;
}
