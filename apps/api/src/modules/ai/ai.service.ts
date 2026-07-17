import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';

/**
 * Honesty contract for this module:
 *
 *  - `method` labels how each insight was produced. Currently only two values,
 *    and both are exactly what they say:
 *      DETERMINISTIC — a rule over current data (stock <= reorder level).
 *      STATISTICAL   — a moving average over recent sales.
 *    (LLM-generated is a future value; nothing here uses an LLM.)
 *  - `basis` states the actual numbers the insight came from, so an owner can
 *    check the maths. Nothing is presented without its evidence.
 *  - `confidence` is honest, not decorative: a forecast built on three days of
 *    data says so, and a restaurant with no history gets NO forecast rather
 *    than a fabricated one.
 *
 * There is no persistence and no cache: insights are recomputed from live rows
 * each request. A stale cached prediction is worse than a fresh cheap one, and
 * these queries are small. RLS scopes everything.
 */

type Method = 'DETERMINISTIC' | 'STATISTICAL';
type Confidence = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export type Insight = {
  type: string;
  method: Method;
  severity: 'info' | 'warning';
  title: string;
  detail: string;
  /** The numbers this came from — the explanation, not a summary of it. */
  basis: string;
  confidence?: Confidence;
};

// A moving average over two weeks smooths day-of-week noise without reaching so
// far back that a changed menu pollutes it.
const WINDOW_DAYS = 14;
// Below this many days of stock left, flag it.
const LOW_DAYS_THRESHOLD = 3;

@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  async insights(): Promise<{ generatedAt: string; insights: Insight[] }> {
    // Reuse the inventory rules rather than re-deriving stock — the ledger sum
    // and reorder logic live in one place (InventoryService).
    const ingredients = await this.inventory.list({});
    const forecasts = await this.productForecasts();

    const out: Insight[] = [
      ...this.lowStockInsights(ingredients),
      ...this.demandInsights(forecasts),
      ...(await this.reorderInsights(ingredients, forecasts)),
    ];

    // Warnings first, then by title, so the urgent things lead.
    out.sort((a, b) =>
      a.severity === b.severity
        ? a.title.localeCompare(b.title)
        : a.severity === 'warning'
          ? -1
          : 1,
    );

    return { generatedAt: new Date().toISOString(), insights: out };
  }

  // --- DETERMINISTIC: stock at or below its reorder level -------------------

  private lowStockInsights(
    ingredients: Array<{
      id: string;
      name: string;
      unit: string;
      reorderLevel: number | null;
      currentStock: number;
      isLow: boolean;
    }>,
  ): Insight[] {
    return ingredients
      .filter((i) => i.isLow)
      .map((i) => ({
        type: 'LOW_STOCK',
        method: 'DETERMINISTIC' as const,
        severity: 'warning' as const,
        title: `${i.name} is low`,
        detail: `${i.name} is at or below its reorder level.`,
        basis: `current ${i.currentStock}, reorder at ${i.reorderLevel} (${this.unit(i.unit)})`,
      }));
  }

  // --- STATISTICAL: moving-average demand per product -----------------------

  private demandInsights(forecasts: ProductForecast[]): Insight[] {
    return (
      forecasts
        // Only surface products with enough signal to say something honest.
        .filter((f) => f.confidence !== 'NONE')
        .slice(0, 8)
        .map((f) => ({
          type: 'DEMAND_FORECAST',
          method: 'STATISTICAL' as const,
          severity: 'info' as const,
          title: `${f.name}: ~${f.perDay}/day expected`,
          detail:
            f.confidence === 'LOW'
              ? `Early estimate for ${f.name} — not much history yet.`
              : `${f.name} is selling about ${f.perDay} a day.`,
          basis: `${f.totalSold} sold over ${f.daysWithSales} active day(s) in the last ${WINDOW_DAYS} days`,
          confidence: f.confidence,
        }))
    );
  }

  // --- STATISTICAL + DETERMINISTIC: reorder from forecast vs stock ----------

  private async reorderInsights(
    ingredients: Array<{
      id: string;
      name: string;
      unit: string;
      currentStock: number;
    }>,
    forecasts: ProductForecast[],
  ): Promise<Insight[]> {
    // How much of each ingredient the day's forecast consumes, via recipes.
    const perDay = new Map<string, number>();
    const recipes = await this.prisma.tx((db) =>
      db.recipeItem.findMany({
        select: { productId: true, ingredientId: true, quantity: true },
      }),
    );
    const forecastByProduct = new Map(
      forecasts.map((f) => [f.productId, f.perDay]),
    );

    for (const r of recipes) {
      const productPerDay = forecastByProduct.get(r.productId) ?? 0;
      if (productPerDay <= 0) continue;
      perDay.set(
        r.ingredientId,
        (perDay.get(r.ingredientId) ?? 0) + productPerDay * r.quantity,
      );
    }

    const out: Insight[] = [];
    for (const ing of ingredients) {
      const consumption = perDay.get(ing.id);
      // No forecast consumption = nothing statistical to say about reorder.
      if (!consumption || consumption <= 0) continue;

      const daysLeft = ing.currentStock / consumption;
      if (daysLeft >= LOW_DAYS_THRESHOLD) continue;

      out.push({
        type: 'REORDER_SUGGESTION',
        method: 'STATISTICAL',
        severity: 'warning',
        title: `${ing.name} runs out in ~${Math.max(0, Math.floor(daysLeft))} day(s)`,
        detail: `At the current rate you will run low on ${ing.name} soon.`,
        basis: `stock ${ing.currentStock} ${this.unit(ing.unit)}, using ~${Math.round(consumption)}/day (from recent sales × recipes)`,
        confidence: 'MEDIUM',
      });
    }
    return out;
  }

  /**
   * Moving-average daily demand per active product, from the last 14 days of
   * non-void sales.
   *
   * perDay is total sold over the WINDOW, not over active days only — the
   * expected daily rate must count the zero-sale days too, or it overstates
   * demand. Confidence is set from how much data actually backs it.
   */
  private async productForecasts(): Promise<ProductForecast[]> {
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);

    return this.prisma.tx(async (db) => {
      const products = await db.product.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
      });

      // Units sold per product, and the count of distinct days each sold on.
      const rows = await db.$queryRaw<
        Array<{ product_id: string | null; total: bigint; active_days: bigint }>
      >`
        SELECT oi.product_id,
               COALESCE(SUM(oi.quantity), 0)::bigint AS total,
               COUNT(DISTINCT date_trunc('day', oi.created_at))::bigint AS active_days
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.status NOT IN ('VOIDED', 'CANCELLED')
          AND oi.created_at >= ${since}
        GROUP BY oi.product_id
      `;
      const sales = new Map(
        rows
          .filter((r) => r.product_id)
          .map((r) => [
            r.product_id!,
            { total: Number(r.total), days: Number(r.active_days) },
          ]),
      );

      return products
        .map((p): ProductForecast => {
          const s = sales.get(p.id) ?? { total: 0, days: 0 };
          const perDay = Math.round(s.total / WINDOW_DAYS);
          return {
            productId: p.id,
            name: p.name,
            totalSold: s.total,
            daysWithSales: s.days,
            perDay,
            confidence: this.confidence(s.total, s.days),
          };
        })
        .sort((a, b) => b.totalSold - a.totalSold);
    });
  }

  /**
   * Honest confidence from data volume. Never inflated — a couple of sales is
   * LOW and says so; no sales is NONE and produces no forecast at all.
   */
  private confidence(totalSold: number, daysWithSales: number): Confidence {
    if (totalSold === 0) return 'NONE';
    if (daysWithSales < 3 || totalSold < 5) return 'LOW';
    if (daysWithSales < 7) return 'MEDIUM';
    return 'HIGH';
  }

  private unit(unit: string): string {
    return unit === 'GRAM' ? 'g' : unit === 'MILLILITRE' ? 'ml' : 'pcs';
  }
}

type ProductForecast = {
  productId: string;
  name: string;
  totalSold: number;
  daysWithSales: number;
  perDay: number;
  confidence: Confidence;
};
