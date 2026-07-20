import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService, type TxClient } from '../../prisma/prisma.service';
import type {
  CreateAdjustmentDto,
  CreateIngredientDto,
  CreateMovementDto,
  ListIngredientsQuery,
  SetRecipeDto,
} from './dto/inventory.dto';

/** Sign is derived from the movement type, never taken from the client. */
const SIGN: Record<string, number> = {
  PURCHASE: 1,
  WASTE: -1,
  CONSUMPTION: -1,
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
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          unit: true,
          reorderLevel: true,
        },
        orderBy: { name: 'asc' },
      });

      // Operational context per row, still a fixed number of queries however
      // many ingredients exist: last ledger touch, and the 7-day CONSUMPTION
      // total that a daily-usage figure is honestly derived from.
      const weekAgo = new Date(Date.now() - 7 * 86_400_000);
      const [stock, lastMoves, recentUse] = await Promise.all([
        this.stockByIngredient(db),
        db.stockMovement.groupBy({
          by: ['ingredientId'],
          _max: { createdAt: true },
        }),
        db.stockMovement.groupBy({
          by: ['ingredientId'],
          where: { type: 'CONSUMPTION', createdAt: { gte: weekAgo } },
          _sum: { quantity: true },
        }),
      ]);
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
          createdAt: true,
        },
      });
      if (!ingredient) throw new NotFoundException('Ingredient not found');

      const [agg, movements] = await Promise.all([
        db.stockMovement.aggregate({
          where: { ingredientId: id },
          _sum: { quantity: true },
        }),
        // The ledger is the interesting part: not just how much, but where it
        // went.
        db.stockMovement.findMany({
          where: { ingredientId: id },
          take: 50,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            type: true,
            quantity: true,
            note: true,
            orderId: true,
            createdAt: true,
          },
        }),
      ]);

      const currentStock = agg._sum?.quantity ?? 0;
      return {
        ...ingredient,
        currentStock,
        isLow:
          ingredient.reorderLevel !== null &&
          currentStock <= ingredient.reorderLevel,
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

    return this.prisma.tx(async (db) => {
      await this.requireIngredient(db, ingredientId);
      return db.stockMovement.create({
        data: {
          restaurantId: ctx.restaurantId,
          ingredientId,
          type: dto.type,
          quantity: sign * dto.quantity,
          note: dto.note ?? null,
          actorUserId: ctx.userId,
        },
        select: { id: true, type: true, quantity: true, createdAt: true },
      });
    });
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

    return this.prisma.tx(async (db) => {
      await this.requireIngredient(db, ingredientId);
      return db.stockMovement.create({
        data: {
          restaurantId: ctx.restaurantId,
          ingredientId,
          type: 'ADJUSTMENT',
          quantity: dto.quantity,
          note: dto.note ?? null,
          actorUserId: ctx.userId,
        },
        select: { id: true, type: true, quantity: true, createdAt: true },
      });
    });
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
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002';
}
