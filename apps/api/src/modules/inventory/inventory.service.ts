import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService, type TxClient } from '../../prisma/prisma.service';
import type { StockMovementType } from '../../generated/prisma/enums';
import { ManualMovementType } from './dto/inventory.dto';
import type {
  CreateAdjustmentDto,
  CreateIngredientDto,
  CreateMovementDto,
  CreateSupplierDto,
  ListIngredientsQuery,
  SetRecipeDto,
  UpdateIngredientDto,
  UpdateSupplierDto,
} from './dto/inventory.dto';

/** Sign is derived from the movement type, never taken from the client. */
const SIGN: Record<string, number> = {
  PURCHASE: 1,
  WASTE: -1,
  CONSUMPTION: -1,
};

/** What both manual-movement endpoints return, and the idempotent replay reads back. */
const MOVEMENT_SELECT = {
  id: true,
  type: true,
  quantity: true,
  createdAt: true,
} as const;

type MovementRow = {
  id: string;
  type: StockMovementType;
  quantity: number;
  createdAt: Date;
};

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ingredients with their current stock.
   *
   * Stock is SUM(movements), computed here rather than read from a column.
   * groupBy keeps it to two queries regardless of ingredient count — the naive
   * version would be one query per ingredient.
   */
  async list(query: ListIngredientsQuery) {
    return this.prisma.tx(async (db) => {
      const ingredients = await db.ingredient.findMany({
        where: query.include === 'all' ? undefined : { isActive: true },
        select: {
          id: true,
          name: true,
          unit: true,
          reorderLevel: true,
          isActive: true,
        },
        orderBy: { name: 'asc' },
      });

      // Operational context per row, still a fixed number of queries however
      // many ingredients exist: last ledger touch, the 7-day CONSUMPTION total
      // that a daily-usage figure is honestly derived from, and the purchase
      // totals that a weighted-average unit cost comes from.
      const weekAgo = new Date(Date.now() - 7 * 86_400_000);
      // Serial, not Promise.all: concurrent queries share this transaction's one
      // pg connection — unsafe under @prisma/adapter-pg (removed in pg v9).
      const [stock, lastMoves, recentUse, cost] = [
        await this.stockByIngredient(db),
        await db.stockMovement.groupBy({
          by: ['ingredientId'],
          _max: { createdAt: true },
        }),
        await db.stockMovement.groupBy({
          by: ['ingredientId'],
          where: { type: 'CONSUMPTION', createdAt: { gte: weekAgo } },
          _sum: { quantity: true },
        }),
        await this.costByIngredient(db),
      ];
      const lastById = new Map(
        lastMoves.map((g) => [g.ingredientId, g._max?.createdAt ?? null]),
      );
      const useById = new Map(
        recentUse.map((g) => [g.ingredientId, Math.abs(g._sum?.quantity ?? 0)]),
      );

      const rows = ingredients.map((i) => {
        const current = stock.get(i.id) ?? 0;
        return {
          ...i,
          currentStock: current,
          // Null reorderLevel means "do not track", which is not the same as
          // a level of zero.
          isLow: i.reorderLevel !== null && current <= i.reorderLevel,
          lastMovementAt: lastById.get(i.id) ?? null,
          // Average of the last 7 days of automatic depletion, rounded to the
          // base unit. Zero simply means nothing was consumed this week.
          avgDailyUsage: Math.round((useById.get(i.id) ?? 0) / 7),
          // Weighted-average purchase cost per base unit (paise, fractional).
          // Null = never purchased with a recorded cost, so no cost basis.
          avgUnitCostMinor: cost.get(i.id) ?? null,
        };
      });

      return query.lowStock ? rows.filter((r) => r.isLow) : rows;
    });
  }

  async getById(id: string) {
    return this.prisma.tx(async (db) => {
      const ingredient = await db.ingredient.findFirst({
        where: { id },
        select: {
          id: true,
          name: true,
          unit: true,
          reorderLevel: true,
          isActive: true,
          createdAt: true,
        },
      });
      if (!ingredient) throw new NotFoundException('Ingredient not found');

      // Serial, not Promise.all: concurrent queries share this transaction's one
      // pg connection — unsafe under @prisma/adapter-pg (removed in pg v9).
      const [agg, movements, cost] = [
        await db.stockMovement.aggregate({
          where: { ingredientId: id },
          _sum: { quantity: true },
        }),
        // The ledger is the interesting part: not just how much, but where it
        // went — and what a purchase cost.
        await db.stockMovement.findMany({
          where: { ingredientId: id },
          take: 50,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            type: true,
            quantity: true,
            note: true,
            orderId: true,
            totalCostMinor: true,
            createdAt: true,
          },
        }),
        await this.costByIngredient(db),
      ];

      const currentStock = agg._sum?.quantity ?? 0;
      return {
        ...ingredient,
        currentStock,
        isLow:
          ingredient.reorderLevel !== null &&
          currentStock <= ingredient.reorderLevel,
        avgUnitCostMinor: cost.get(id) ?? null,
        movements,
      };
    });
  }

  async create(dto: CreateIngredientDto) {
    const ctx = this.prisma.requireContext();
    try {
      return await this.prisma.tx((db) =>
        db.ingredient.create({
          data: {
            restaurantId: ctx.restaurantId,
            name: dto.name,
            unit: dto.unit,
            reorderLevel: dto.reorderLevel ?? null,
          },
          select: { id: true, name: true, unit: true, reorderLevel: true },
        }),
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('An ingredient with that name exists');
      }
      throw e;
    }
  }

  /**
   * Edits an ingredient in place.
   *
   * The one guarded field is `unit`: the ledger's quantities and every recipe
   * quantity are integers in the CURRENT unit. Changing the label under them
   * would turn 500 g of paneer into 500 ml without moving anything, so a unit
   * change is allowed only while nothing has been recorded against the
   * ingredient. After that, the honest correction is a new ingredient.
   */
  async update(id: string, dto: UpdateIngredientDto) {
    return this.prisma.tx(async (db) => {
      const existing = await db.ingredient.findFirst({
        where: { id },
        select: { id: true, unit: true },
      });
      if (!existing) throw new NotFoundException('Ingredient not found');

      if (dto.unit !== undefined && dto.unit !== existing.unit) {
        // Serial, not Promise.all: concurrent queries share this transaction's
        // one pg connection — unsafe under @prisma/adapter-pg (removed in pg v9).
        const [movements, recipes] = [
          await db.stockMovement.count({ where: { ingredientId: id } }),
          await db.recipeItem.count({ where: { ingredientId: id } }),
        ];
        if (movements > 0 || recipes > 0) {
          throw new ConflictException(
            'Unit cannot change once stock or recipes are recorded in it — add a new ingredient instead',
          );
        }
      }

      try {
        return await db.ingredient.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
            // null clears the reorder level (stop tracking); undefined leaves it.
            ...(dto.reorderLevel !== undefined
              ? { reorderLevel: dto.reorderLevel }
              : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
          select: {
            id: true,
            name: true,
            unit: true,
            reorderLevel: true,
            isActive: true,
          },
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new ConflictException('An ingredient with that name exists');
        }
        throw e;
      }
    });
  }

  /**
   * Records a PURCHASE or WASTE.
   *
   * The client sends a positive magnitude; the sign comes from the type. That
   * asymmetry is deliberate — a client that could choose the sign could post a
   * "WASTE" that quietly added stock.
   */
  async recordMovement(ingredientId: string, dto: CreateMovementDto) {
    const ctx = this.prisma.requireContext();
    const sign = SIGN[dto.type];
    if (sign === undefined) {
      throw new BadRequestException('Unsupported movement type');
    }

    // Supplier and cost belong to a PURCHASE only — a WASTE or a count has no
    // supplier and no receipt. Verify the supplier belongs to this tenant.
    const isPurchase = dto.type === ManualMovementType.PURCHASE;
    return this.writeOnce(dto.idempotencyKey, () =>
      this.prisma.tx(async (db) => {
        await this.requireIngredient(db, ingredientId);
        if (isPurchase && dto.supplierId) {
          const supplier = await db.supplier.findFirst({
            where: { id: dto.supplierId },
            select: { id: true },
          });
          if (!supplier) throw new BadRequestException('Unknown supplier');
        }
        return db.stockMovement.create({
          data: {
            restaurantId: ctx.restaurantId,
            ingredientId,
            type: dto.type,
            quantity: sign * dto.quantity,
            note: dto.note ?? null,
            actorUserId: ctx.userId,
            ...(isPurchase && dto.supplierId
              ? { supplierId: dto.supplierId }
              : {}),
            ...(isPurchase && dto.totalCostMinor !== undefined
              ? { totalCostMinor: dto.totalCostMinor }
              : {}),
            idempotencyKey: dto.idempotencyKey ?? null,
          },
          select: MOVEMENT_SELECT,
        });
      }),
    );
  }

  /**
   * A stock count. Signed, because reality can be above or below the ledger.
   *
   * Note this appends rather than rewriting: the discrepancy stays visible.
   * That is the point — a stock count that silently overwrote history would
   * erase the evidence of whatever caused the discrepancy.
   */
  async recordAdjustment(ingredientId: string, dto: CreateAdjustmentDto) {
    const ctx = this.prisma.requireContext();
    if (dto.quantity === 0) {
      // The DB CHECK would reject it anyway; a clearer message here.
      throw new BadRequestException('An adjustment of zero records nothing');
    }

    return this.writeOnce(dto.idempotencyKey, () =>
      this.prisma.tx(async (db) => {
        await this.requireIngredient(db, ingredientId);
        return db.stockMovement.create({
          data: {
            restaurantId: ctx.restaurantId,
            ingredientId,
            type: 'ADJUSTMENT',
            quantity: dto.quantity,
            note: dto.note ?? null,
            actorUserId: ctx.userId,
            idempotencyKey: dto.idempotencyKey ?? null,
          },
          select: MOVEMENT_SELECT,
        });
      }),
    );
  }

  /**
   * Runs a manual stock-movement write exactly once for a given idempotency
   * key. Same shape as OrdersService.create: the DB unique index is the
   * guarantee; this turns a replay or a lost concurrent race into the original
   * row instead of a duplicate. The recovery read runs in a FRESH transaction —
   * the one that hit the unique violation is already rolled back.
   */
  private async writeOnce(
    key: string | undefined,
    write: () => Promise<MovementRow>,
  ): Promise<MovementRow> {
    if (key) {
      const existing = await this.findMovementByKey(key);
      if (existing) return existing;
    }
    try {
      return await write();
    } catch (e) {
      // A concurrent identical request won the unique index; return its row.
      if (key && isUniqueViolation(e)) {
        const existing = await this.findMovementByKey(key);
        if (existing) return existing;
      }
      throw e;
    }
  }

  /** The movement already written for this key, or null. RLS scopes it to the tenant. */
  private findMovementByKey(
    idempotencyKey: string,
  ): Promise<MovementRow | null> {
    return this.prisma.tx((db) =>
      db.stockMovement.findFirst({
        where: { idempotencyKey },
        select: MOVEMENT_SELECT,
      }),
    );
  }

  async getRecipe(productId: string) {
    return this.prisma.tx(async (db) => {
      const product = await db.product.findFirst({
        where: { id: productId },
        select: { id: true, name: true },
      });
      if (!product) throw new NotFoundException('Product not found');

      const items = await db.recipeItem.findMany({
        where: { productId },
        select: {
          id: true,
          quantity: true,
          ingredient: { select: { id: true, name: true, unit: true } },
        },
      });
      return { product, items };
    });
  }

  /**
   * Replaces a product's recipe wholesale.
   *
   * Replace rather than merge so removing an ingredient is possible at all —
   * a merge-only API can add but never subtract.
   */
  async setRecipe(productId: string, dto: SetRecipeDto) {
    const ctx = this.prisma.requireContext();

    return this.prisma.tx(async (db) => {
      const product = await db.product.findFirst({
        where: { id: productId },
        select: { id: true },
      });
      if (!product) throw new NotFoundException('Product not found');

      const ids = [...new Set(dto.items.map((i) => i.ingredientId))];
      if (ids.length !== dto.items.length) {
        throw new BadRequestException('Duplicate ingredient in recipe');
      }

      if (ids.length) {
        // RLS scopes this, so another tenant's ingredient is simply not found.
        const found = await db.ingredient.findMany({
          where: { id: { in: ids } },
          select: { id: true },
        });
        if (found.length !== ids.length) {
          throw new BadRequestException('Unknown ingredient');
        }
      }

      await db.recipeItem.deleteMany({ where: { productId } });
      if (dto.items.length) {
        await db.recipeItem.createMany({
          data: dto.items.map((i) => ({
            restaurantId: ctx.restaurantId,
            productId,
            ingredientId: i.ingredientId,
            quantity: i.quantity,
          })),
        });
      }

      return this.getRecipeIn(db, productId);
    });
  }

  /**
   * Depletes stock for a placed order. Called by OrdersService INSIDE the order
   * transaction, so stock and the sale commit together or not at all.
   *
   * Deliberately does NOT block a sale when stock is short. A restaurant that
   * cannot sell because a number in a database says zero is a worse outcome
   * than a negative stock level — the ledger records what really happened and
   * the owner sees the discrepancy. Reality wins over bookkeeping.
   */
  async depleteForOrder(
    db: TxClient,
    restaurantId: string,
    userId: string,
    orderId: string,
    lines: Array<{ productId: string; quantity: number }>,
  ): Promise<void> {
    const productIds = [...new Set(lines.map((l) => l.productId))];
    const recipes = await db.recipeItem.findMany({
      where: { productId: { in: productIds } },
      select: { productId: true, ingredientId: true, quantity: true },
    });
    // Products without a recipe deplete nothing. That is legitimate: a bottled
    // drink is bought and sold as-is.
    if (!recipes.length) return;

    // Sum per ingredient first: one movement per ingredient per order, rather
    // than one per line, keeps the ledger readable.
    const totals = new Map<string, number>();
    for (const line of lines) {
      for (const r of recipes.filter((x) => x.productId === line.productId)) {
        totals.set(
          r.ingredientId,
          (totals.get(r.ingredientId) ?? 0) + r.quantity * line.quantity,
        );
      }
    }
    if (!totals.size) return;

    await db.stockMovement.createMany({
      data: [...totals].map(([ingredientId, qty]) => ({
        restaurantId,
        ingredientId,
        type: 'CONSUMPTION' as const,
        quantity: -qty, // sign is ours, never the client's
        orderId,
        actorUserId: userId,
      })),
    });
  }

  /**
   * Returns an order's consumed stock when the sale is reversed (voided or
   * cancelled). Called by OrdersService INSIDE the status-change transaction,
   * so the reversal and the status commit together or not at all.
   *
   * Computed from the order's OWN consumption rows, not from the recipe: a
   * recipe edited between the sale and the void must not change how much comes
   * back. The rows are appended, never removed — the ledger is append-only, so
   * both the depletion and its reversal stay on the record, which is what an
   * auditor needs to see.
   */
  async restockForReversedOrder(
    db: TxClient,
    restaurantId: string,
    userId: string,
    orderId: string,
    toStatus: string,
  ): Promise<void> {
    const consumed = await db.stockMovement.findMany({
      where: { orderId, type: 'CONSUMPTION' },
      select: { ingredientId: true, quantity: true },
    });
    // An order with no recipe depleted nothing, so there is nothing to return.
    if (!consumed.length) return;

    // One movement per ingredient, mirroring how depletion was written.
    const totals = new Map<string, number>();
    for (const m of consumed) {
      totals.set(
        m.ingredientId,
        (totals.get(m.ingredientId) ?? 0) - m.quantity,
      );
    }

    const rows = [...totals]
      // stock_movements CHECK (quantity <> 0).
      .filter(([, qty]) => qty !== 0)
      .map(([ingredientId, qty]) => ({
        restaurantId,
        ingredientId,
        // ADJUSTMENT is the one signed type the CHECK allows in both
        // directions. orderId and the note say why it happened.
        type: 'ADJUSTMENT' as const,
        quantity: qty,
        orderId,
        actorUserId: userId,
        note: `Stock returned: order ${toStatus.toLowerCase()}`,
      }));
    if (!rows.length) return;

    await db.stockMovement.createMany({ data: rows });
  }

  private async requireIngredient(db: TxClient, id: string) {
    const found = await db.ingredient.findFirst({
      where: { id },
      select: { id: true },
    });
    // Another tenant's ingredient does not exist here.
    if (!found) throw new NotFoundException('Ingredient not found');
    return found;
  }

  private async getRecipeIn(db: TxClient, productId: string) {
    const items = await db.recipeItem.findMany({
      where: { productId },
      select: {
        id: true,
        quantity: true,
        ingredient: { select: { id: true, name: true, unit: true } },
      },
    });
    return { productId, items };
  }

  /** ingredientId -> current stock, in one query. */
  private async stockByIngredient(db: TxClient): Promise<Map<string, number>> {
    const grouped = await db.stockMovement.groupBy({
      by: ['ingredientId'],
      _sum: { quantity: true },
    });
    return new Map(grouped.map((g) => [g.ingredientId, g._sum?.quantity ?? 0]));
  }

  /**
   * ingredientId -> weighted-average unit cost (paise per base unit,
   * fractional), from PURCHASE movements that recorded a cost. Weighted
   * average = SUM(total_cost) / SUM(quantity purchased) — the standard cost
   * method, and correct even when prices change between deliveries.
   *
   * Purchases without a recorded cost do not distort it: they contribute
   * neither to the cost sum nor (deliberately) to the quantity sum here, so a
   * free sample or an unpriced receive is simply excluded from the average.
   *
   * ponytail: weighted-average, not FIFO. FIFO COGS needs lot tracking; the
   * average is what a counter kitchen actually reasons about.
   */
  private async costByIngredient(db: TxClient): Promise<Map<string, number>> {
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

  // -- suppliers ------------------------------------------------------------

  listSuppliers(includeInactive = false) {
    return this.prisma.tx((db) =>
      db.supplier.findMany({
        where: includeInactive ? undefined : { isActive: true },
        select: {
          id: true,
          name: true,
          phone: true,
          notes: true,
          isActive: true,
        },
        orderBy: { name: 'asc' },
      }),
    );
  }

  async createSupplier(dto: CreateSupplierDto) {
    const ctx = this.prisma.requireContext();
    try {
      return await this.prisma.tx((db) =>
        db.supplier.create({
          data: {
            restaurantId: ctx.restaurantId,
            name: dto.name,
            phone: dto.phone ?? null,
            notes: dto.notes ?? null,
          },
          select: {
            id: true,
            name: true,
            phone: true,
            notes: true,
            isActive: true,
          },
        }),
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('A supplier with that name exists');
      }
      throw e;
    }
  }

  async updateSupplier(id: string, dto: UpdateSupplierDto) {
    return this.prisma.tx(async (db) => {
      const existing = await db.supplier.findFirst({
        where: { id },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Supplier not found');
      try {
        return await db.supplier.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
            ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
          select: {
            id: true,
            name: true,
            phone: true,
            notes: true,
            isActive: true,
          },
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new ConflictException('A supplier with that name exists');
        }
        throw e;
      }
    });
  }

  /**
   * Food-cost analysis per product: recipe cost from the weighted-average
   * ingredient costs, and the margin against the current price.
   *
   * A product with no recipe, or one whose recipe uses an ingredient with no
   * cost basis, reports costed:false — the honest "we cannot cost this yet"
   * rather than a fake zero that would flatter the margin.
   */
  async productCosting() {
    return this.prisma.tx(async (db) => {
      // Serial, not Promise.all: concurrent queries share this transaction's one
      // pg connection — unsafe under @prisma/adapter-pg (removed in pg v9).
      const [products, recipeItems, cost] = [
        await db.product.findMany({
          where: { isActive: true },
          select: { id: true, name: true, priceMinor: true },
          orderBy: { name: 'asc' },
        }),
        await db.recipeItem.findMany({
          select: { productId: true, ingredientId: true, quantity: true },
        }),
        await this.costByIngredient(db),
      ];

      const itemsByProduct = new Map<
        string,
        Array<{ ingredientId: string; quantity: number }>
      >();
      for (const ri of recipeItems) {
        const arr = itemsByProduct.get(ri.productId) ?? [];
        arr.push({ ingredientId: ri.ingredientId, quantity: ri.quantity });
        itemsByProduct.set(ri.productId, arr);
      }

      return products.map((p) => {
        const items = itemsByProduct.get(p.id) ?? [];
        // No recipe, or a missing cost basis on any ingredient, means the
        // recipe cost is unknowable — do not fabricate one.
        const hasRecipe = items.length > 0;
        const allCosted = items.every((it) => cost.has(it.ingredientId));
        const costed = hasRecipe && allCosted;

        const recipeCostMinor = costed
          ? Math.round(
              items.reduce(
                (s, it) => s + (cost.get(it.ingredientId) ?? 0) * it.quantity,
                0,
              ),
            )
          : null;
        const marginMinor =
          recipeCostMinor === null ? null : p.priceMinor - recipeCostMinor;
        const foodCostPct =
          recipeCostMinor === null || p.priceMinor === 0
            ? null
            : Math.round((recipeCostMinor / p.priceMinor) * 1000) / 10;

        return {
          id: p.id,
          name: p.name,
          priceMinor: p.priceMinor,
          costed,
          hasRecipe,
          recipeCostMinor,
          marginMinor,
          foodCostPct,
        };
      });
    });
  }
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002';
}
