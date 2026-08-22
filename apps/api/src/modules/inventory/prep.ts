import { BadRequestException } from '@nestjs/common';

/**
 * Prep-inventory maths, kept pure and tested. None of this touches the database
 * or the clock (callers pass `now`), so every rule below — how a recipe scales
 * to a batch, which batch FEFO consumes, what a batch costs — is exercised by
 * prep.spec.ts without a DB.
 *
 * Every quantity is an integer in a stock item's base unit (grams / millilitres
 * / pieces), exactly like the rest of inventory. Units are NEVER converted
 * across dimensions: a component is consumed in ITS OWN unit, so a filling made
 * from grams of paneer and millilitres of oil records grams against paneer and
 * millilitres against oil — there is no kg→piece maths to get wrong.
 */

export type Component = { ingredientId: string; quantity: number };

/**
 * Scale a prep recipe's component quantities from its standard yield to a
 * planned batch yield: consumed = round(component × planned / standard).
 *
 * The recipe stays the standard (section 8) — this scales it, it never rewrites
 * it. Rounding can land a tiny component at 0 ("negligible at this size"); the
 * caller drops zeros, since a zero movement is meaningless in the ledger.
 */
export function scaleComponents(
  components: Component[],
  standardYield: number,
  plannedYield: number,
): Component[] {
  if (standardYield <= 0) {
    throw new BadRequestException('Prep recipe has no yield to scale from');
  }
  if (plannedYield <= 0) {
    throw new BadRequestException('Batch quantity must be positive');
  }
  return components.map((c) => ({
    ingredientId: c.ingredientId,
    quantity: Math.round((c.quantity * plannedYield) / standardYield),
  }));
}

/** Expected vs actual yield: signed delta (base units) and signed percent. */
export function yieldVariance(
  expected: number,
  actual: number,
): { delta: number; pct: number | null } {
  return {
    delta: actual - expected,
    pct:
      expected > 0
        ? Math.round(((actual - expected) / expected) * 1000) / 10
        : null,
  };
}

/**
 * Where a component is short for a planned batch. Empty = everything is in
 * stock. Prep BLOCKS on a shortfall (unlike a sale, which never blocks): a
 * batch is a deliberate kitchen action, so it refuses rather than inventing raw
 * stock that was not there.
 */
export function findShortfalls(
  components: Component[],
  stock: Map<string, number>,
): Array<{
  ingredientId: string;
  need: number;
  available: number;
  short: number;
}> {
  const out: Array<{
    ingredientId: string;
    need: number;
    available: number;
    short: number;
  }> = [];
  for (const c of components) {
    if (c.quantity <= 0) continue;
    const available = stock.get(c.ingredientId) ?? 0;
    if (available < c.quantity) {
      out.push({
        ingredientId: c.ingredientId,
        need: c.quantity,
        available,
        short: c.quantity - available,
      });
    }
  }
  return out;
}

export type LiveBatch = {
  id: string;
  remaining: number;
  expiresAt: Date | null;
  createdAt: Date;
};

/**
 * FEFO allocation of prepared stock across a prep item's batches.
 *
 * Consumes `need` earliest-expiry-first (nulls — no expiry — last), then
 * earliest-prepared. EXPIRED batches are never selected (section 14). Anything
 * left after the live batches are exhausted comes back as a single null-batch
 * remainder: the sale still completes and stock still reflects reality (goes
 * negative), but an expired batch is never silently drawn down to do it.
 */
export function allocateFefo(
  batches: LiveBatch[],
  need: number,
  now: Date,
): Array<{ prepBatchId: string | null; quantity: number }> {
  if (need <= 0) return [];
  const live = batches
    .filter(
      (b) => b.remaining > 0 && (b.expiresAt === null || b.expiresAt > now),
    )
    .sort((a, b) => {
      const ax = a.expiresAt ? a.expiresAt.getTime() : Infinity;
      const bx = b.expiresAt ? b.expiresAt.getTime() : Infinity;
      if (ax !== bx) return ax - bx;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

  const out: Array<{ prepBatchId: string | null; quantity: number }> = [];
  let left = need;
  for (const b of live) {
    if (left <= 0) break;
    const take = Math.min(left, b.remaining);
    out.push({ prepBatchId: b.id, quantity: take });
    left -= take;
  }
  if (left > 0) out.push({ prepBatchId: null, quantity: left });
  return out;
}

/**
 * Raw cost of a batch (paise) from the components it consumed and the
 * weighted-average unit costs inventory already computes. Null if ANY component
 * has no cost basis — the honest "cannot cost this", never a fabricated zero
 * that would flatter a margin (section 19).
 */
export function batchCost(
  components: Component[],
  unitCost: Map<string, number>,
): number | null {
  let total = 0;
  for (const c of components) {
    const u = unitCost.get(c.ingredientId);
    if (u == null) return null;
    total += u * c.quantity;
  }
  return Math.round(total);
}

/**
 * A human batch code, PB-YYMMDD-XXXX. The uuid is the real key; this is just a
 * label staff can read out. `suffix` is injectable so the format is testable.
 */
export function batchCode(
  now: Date,
  suffix: string = Math.random().toString(36).slice(2, 6).toUpperCase(),
): string {
  const y = String(now.getUTCFullYear()).slice(2);
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `PB-${y}${m}${d}-${suffix.toUpperCase().padStart(4, '0').slice(0, 4)}`;
}
