import type { TxClient } from '../../prisma/prisma.service';

/**
 * Shared stock-ledger aggregates, so the inventory list, the prep dashboard and
 * batch costing all read the SAME numbers. Stock is SUM(movements); cost is the
 * weighted-average purchase cost. Pulling these out of InventoryService keeps
 * one definition of "current stock" and "unit cost" rather than a second copy
 * in PrepService that could drift.
 */

/** ingredientId -> current stock (base units), in one query. */
export async function stockByIngredient(
  db: TxClient,
): Promise<Map<string, number>> {
  const grouped = await db.stockMovement.groupBy({
    by: ['ingredientId'],
    _sum: { quantity: true },
  });
  return new Map(grouped.map((g) => [g.ingredientId, g._sum?.quantity ?? 0]));
}

/**
 * prepBatchId -> remaining stock (SUM of the batch's ledger rows), in one
 * query. A batch's remaining is exactly its PREP_OUTPUT plus every later
 * CONSUMPTION/WASTE/ADJUSTMENT tagged with its id — the same
 * stock-is-the-ledger discipline as an ingredient, one level down. Empty in →
 * empty out.
 */
export async function remainingByBatch(
  db: TxClient,
  batchIds: string[],
): Promise<Map<string, number>> {
  if (!batchIds.length) return new Map();
  const grouped = await db.stockMovement.groupBy({
    by: ['prepBatchId'],
    // Exclude the raw-consumption leg: a batch carries both its raw draw
    // (PREP_BATCH, negative, on the raw ingredients) and its prepared output
    // (PREP_OUTPUT, positive) under the same prepBatchId. Remaining is the
    // PREPARED stock only — output plus later CONSUMPTION/WASTE/ADJUSTMENT —
    // so summing the raw leg in would wrongly net grams of paneer against
    // grams of filling.
    where: { prepBatchId: { in: batchIds }, type: { not: 'PREP_BATCH' } },
    _sum: { quantity: true },
  });
  return new Map(
    grouped.map((g) => [g.prepBatchId as string, g._sum?.quantity ?? 0]),
  );
}

/**
 * ingredientId -> weighted-average unit cost (paise per base unit, fractional),
 * from PURCHASE movements that recorded a cost. Weighted average =
 * SUM(total_cost) / SUM(quantity purchased) — correct even when prices change
 * between deliveries. Purchases without a recorded cost are excluded from both
 * sums, so a free sample does not distort it.
 *
 * ponytail: weighted-average, not FIFO. FIFO COGS needs lot tracking; the
 * average is what a counter kitchen actually reasons about.
 */
export async function costByIngredient(
  db: TxClient,
): Promise<Map<string, number>> {
  const rows = await db.$queryRaw<
    Array<{ ingredient_id: string; cost: bigint; qty: bigint }>
  >`
    SELECT ingredient_id,
           COALESCE(SUM(total_cost_minor), 0)::bigint AS cost,
           COALESCE(SUM(quantity) FILTER (WHERE total_cost_minor IS NOT NULL), 0)::bigint AS qty
    FROM stock_movements
    WHERE type = 'PURCHASE' AND total_cost_minor IS NOT NULL
    GROUP BY ingredient_id
  `;
  const out = new Map<string, number>();
  for (const r of rows) {
    const qty = Number(r.qty);
    if (qty > 0) out.set(r.ingredient_id, Number(r.cost) / qty);
  }
  return out;
}
