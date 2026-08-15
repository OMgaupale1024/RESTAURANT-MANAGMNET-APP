import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService, type TxClient } from '../../prisma/prisma.service';
import type {
  CreateBatchDto,
  CreatePrepItemDto,
  SetPrepRecipeDto,
  UpdatePrepItemDto,
  WasteBatchDto,
} from './dto/prep.dto';
import {
  costByIngredient,
  remainingByBatch,
  stockByIngredient,
} from './stock-queries';
import {
  batchCode,
  batchCost,
  findShortfalls,
  scaleComponents,
  yieldVariance,
  type Component,
} from './prep';

/** The IST day boundary — India has no DST, so a fixed +05:30 is exact. */
function istDayStart(): Date {
  return new Date(
    `${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}T00:00:00.000+05:30`,
  );
}

/**
 * Prepared inventory: a kitchen makes a prepared ingredient from raw ones and
 * stocks it in batches. This owns the prep recipes, the batches, the prep
 * dashboard and batch waste. The SALE-time draw-down of prepared stock lives in
 * InventoryService.depleteForOrder (FEFO) — where all consumption already is —
 * so there is exactly one consumption path, not a prep-specific fork.
 */
@Injectable()
export class PrepService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------- items / board

  /**
   * The prep dashboard: prepared items with available stock, what was prepared
   * and wasted today, and how many live batches are expiring soon or already
   * expired. Kitchen-facing, so no cost — that is owner detail. A fixed number
   * of queries regardless of how many prep items or batches exist.
   */
  async listItems() {
    return this.prisma.tx(async (db) => {
      const items = await db.ingredient.findMany({
        where: { isPrepared: true, isActive: true },
        select: {
          id: true,
          name: true,
          unit: true,
          reorderLevel: true,
          prepBatchYield: true,
          prepShelfLifeHours: true,
        },
        orderBy: { name: 'asc' },
      });
      if (!items.length) return [];
      const ids = items.map((i) => i.id);
      const today = istDayStart();

      // Serial, not Promise.all: concurrent queries share this transaction's one
      // pg connection — unsafe under @prisma/adapter-pg (removed in pg v9).
      const [stock, batches, preparedToday, wasteToday, recipeCounts] = [
        await stockByIngredient(db),
        await db.prepBatch.findMany({
          where: { prepIngredientId: { in: ids } },
          select: { id: true, prepIngredientId: true, expiresAt: true },
        }),
        await db.stockMovement.groupBy({
          by: ['ingredientId'],
          where: {
            ingredientId: { in: ids },
            type: 'PREP_OUTPUT',
            createdAt: { gte: today },
          },
          _sum: { quantity: true },
        }),
        await db.stockMovement.groupBy({
          by: ['ingredientId'],
          where: {
            ingredientId: { in: ids },
            type: 'WASTE',
            createdAt: { gte: today },
          },
          _sum: { quantity: true },
        }),
        await db.prepRecipeItem.groupBy({
          by: ['prepIngredientId'],
          where: { prepIngredientId: { in: ids } },
          _count: { _all: true },
        }),
      ];
      const remaining = await remainingByBatch(
        db,
        batches.map((b) => b.id),
      );
      const preparedById = new Map(
        preparedToday.map((g) => [g.ingredientId, g._sum?.quantity ?? 0]),
      );
      const wasteById = new Map(
        wasteToday.map((g) => [
          g.ingredientId,
          Math.abs(g._sum?.quantity ?? 0),
        ]),
      );
      const hasRecipe = new Set(recipeCounts.map((g) => g.prepIngredientId));

      const now = Date.now();
      const soon = now + 24 * 3600 * 1000;

      return items.map((i) => {
        let expiringSoon = 0;
        let expired = 0;
        for (const b of batches) {
          if (b.prepIngredientId !== i.id) continue;
          if ((remaining.get(b.id) ?? 0) <= 0) continue;
          if (!b.expiresAt) continue;
          const t = b.expiresAt.getTime();
          if (t <= now) expired++;
          else if (t <= soon) expiringSoon++;
        }
        const available = stock.get(i.id) ?? 0;
        return {
          id: i.id,
          name: i.name,
          unit: i.unit,
          reorderLevel: i.reorderLevel,
          prepBatchYield: i.prepBatchYield,
          prepShelfLifeHours: i.prepShelfLifeHours,
          hasRecipe: hasRecipe.has(i.id),
          available,
          isLow: i.reorderLevel !== null && available <= i.reorderLevel,
          preparedToday: preparedById.get(i.id) ?? 0,
          wasteToday: wasteById.get(i.id) ?? 0,
          expiringSoon,
          expired,
        };
      });
    });
  }

  /**
   * A prep item in full: its recipe (with the standard batch cost, if every
   * component is costed), current stock, and its recent batches with remaining,
   * expiry and yield variance. Owner/manager detail.
   */
  async getItem(id: string) {
    return this.prisma.tx(async (db) => {
      const item = await db.ingredient.findFirst({
        where: { id, isPrepared: true },
        select: {
          id: true,
          name: true,
          unit: true,
          reorderLevel: true,
          isActive: true,
          prepBatchYield: true,
          prepShelfLifeHours: true,
        },
      });
      if (!item) throw new NotFoundException('Prep item not found');

      // Serial (shared tx connection).
      const [recipe, stock, cost, batchRows] = [
        await db.prepRecipeItem.findMany({
          where: { prepIngredientId: id },
          select: {
            componentIngredientId: true,
            quantity: true,
            componentIngredient: {
              select: { id: true, name: true, unit: true, isActive: true },
            },
          },
        }),
        await stockByIngredient(db),
        await costByIngredient(db),
        await db.prepBatch.findMany({
          where: { prepIngredientId: id },
          orderBy: { createdAt: 'desc' },
          take: 30,
          select: {
            id: true,
            code: true,
            expectedQuantity: true,
            actualQuantity: true,
            expiresAt: true,
            costMinor: true,
            note: true,
            createdAt: true,
          },
        }),
      ];
      const remaining = await remainingByBatch(
        db,
        batchRows.map((b) => b.id),
      );

      const components: Component[] = recipe.map((r) => ({
        ingredientId: r.componentIngredientId,
        quantity: r.quantity,
      }));
      // Standard-batch recipe cost, and the derived cost per unit of output.
      const recipeCostMinor = components.length
        ? batchCost(components, cost)
        : null;
      const costPerUnitMinor =
        recipeCostMinor !== null && item.prepBatchYield
          ? Math.round((recipeCostMinor / item.prepBatchYield) * 100) / 100
          : null;

      const now = Date.now();
      return {
        ...item,
        available: stock.get(id) ?? 0,
        isLow:
          item.reorderLevel !== null &&
          (stock.get(id) ?? 0) <= item.reorderLevel,
        recipeCostMinor,
        costPerUnitMinor,
        recipe: recipe.map((r) => ({
          ingredientId: r.componentIngredientId,
          name: r.componentIngredient.name,
          unit: r.componentIngredient.unit,
          isActive: r.componentIngredient.isActive,
          quantity: r.quantity,
          // Current stock of the component, so the prepare form can preview a
          // shortfall before the server blocks it.
          available: stock.get(r.componentIngredientId) ?? 0,
        })),
        batches: batchRows.map((b) => ({
          ...b,
          remaining: remaining.get(b.id) ?? 0,
          expired: b.expiresAt ? b.expiresAt.getTime() <= now : false,
          variance: yieldVariance(b.expectedQuantity, b.actualQuantity),
        })),
      };
    });
  }

  async createItem(dto: CreatePrepItemDto) {
    const ctx = this.prisma.requireContext();
    try {
      return await this.prisma.tx((db) =>
        db.ingredient.create({
          data: {
            restaurantId: ctx.restaurantId,
            name: dto.name,
            unit: dto.unit,
            isPrepared: true,
            reorderLevel: dto.reorderLevel ?? null,
            prepShelfLifeHours: dto.shelfLifeHours ?? null,
          },
          select: {
            id: true,
            name: true,
            unit: true,
            isPrepared: true,
            reorderLevel: true,
            prepShelfLifeHours: true,
          },
        }),
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('An ingredient with that name exists');
      }
      throw e;
    }
  }

  async updateItem(id: string, dto: UpdatePrepItemDto) {
    return this.prisma.tx(async (db) => {
      const existing = await db.ingredient.findFirst({
        where: { id, isPrepared: true },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Prep item not found');
      return db.ingredient.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.shelfLifeHours !== undefined
            ? { prepShelfLifeHours: dto.shelfLifeHours }
            : {}),
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
          prepShelfLifeHours: true,
        },
      });
    });
  }

  /**
   * Sets a prep item's recipe and its standard yield together (they are one
   * thing — "these inputs make this much"). Replace-wholesale, like a product
   * recipe. Components must be active ingredients of this tenant and cannot be
   * the item itself, nor a prepared item that already lists this one (the direct
   * reciprocal — the prep counterpart of an upsell loop).
   */
  async setRecipe(id: string, dto: SetPrepRecipeDto) {
    const ctx = this.prisma.requireContext();
    return this.prisma.tx(async (db) => {
      const item = await db.ingredient.findFirst({
        where: { id, isPrepared: true },
        select: { id: true },
      });
      if (!item) throw new NotFoundException('Prep item not found');

      const ids = [...new Set(dto.items.map((i) => i.ingredientId))];
      if (ids.length !== dto.items.length) {
        throw new BadRequestException('Duplicate component in recipe');
      }
      if (ids.includes(id)) {
        throw new BadRequestException('A prep item cannot contain itself');
      }
      // Components must all be active ingredients of this tenant (RLS-scoped).
      const found = await db.ingredient.findMany({
        where: { id: { in: ids }, isActive: true },
        select: { id: true },
      });
      if (found.length !== ids.length) {
        throw new BadRequestException('One or more components are unavailable');
      }
      // Reject the direct reciprocal: a component whose OWN recipe already uses
      // this item would make a two-step loop.
      const reciprocal = await db.prepRecipeItem.findFirst({
        where: {
          prepIngredientId: { in: ids },
          componentIngredientId: id,
        },
        select: { prepIngredientId: true },
      });
      if (reciprocal) {
        throw new BadRequestException(
          'A component already uses this item — that would loop',
        );
      }

      await db.ingredient.update({
        where: { id },
        data: { prepBatchYield: dto.batchYield },
      });
      await db.prepRecipeItem.deleteMany({ where: { prepIngredientId: id } });
      await db.prepRecipeItem.createMany({
        data: dto.items.map((i) => ({
          restaurantId: ctx.restaurantId,
          prepIngredientId: id,
          componentIngredientId: i.ingredientId,
          quantity: i.quantity,
        })),
      });
      return this.getItem(id);
    });
  }

  // --------------------------------------------------------------- batches

  /**
   * Prepares a batch: scales the recipe to the planned yield, refuses if any raw
   * component is short (a batch is a deliberate action — it does not sell stock
   * that is not there), then in ONE transaction consumes the raw components
   * (PREP_BATCH) and produces the actual yield (PREP_OUTPUT), all tagged with
   * the batch. Idempotent: a replayed key returns the original batch, never a
   * second consumption.
   */
  async createBatch(id: string, dto: CreateBatchDto) {
    if (dto.idempotencyKey) {
      const existing = await this.findBatchByKey(dto.idempotencyKey);
      if (existing) return existing;
    }
    // Retry only guards the human batch code's tiny collision chance; a fresh
    // random code self-heals. An idempotency-key clash is resolved by replay.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.prisma.tx((db) => this.doCreateBatch(db, id, dto));
      } catch (e) {
        if (isUniqueViolation(e)) {
          if (dto.idempotencyKey) {
            const existing = await this.findBatchByKey(dto.idempotencyKey);
            if (existing) return existing;
          }
          continue; // a code collision — try a fresh code
        }
        throw e;
      }
    }
    throw new ConflictException('Could not allocate a batch code — try again');
  }

  private async doCreateBatch(db: TxClient, id: string, dto: CreateBatchDto) {
    const ctx = this.prisma.requireContext();
    const item = await db.ingredient.findFirst({
      where: { id, isPrepared: true },
      select: {
        id: true,
        name: true,
        unit: true,
        prepBatchYield: true,
        prepShelfLifeHours: true,
      },
    });
    if (!item) throw new NotFoundException('Prep item not found');
    if (item.prepBatchYield == null) {
      throw new BadRequestException('Set a recipe before preparing a batch');
    }
    const recipe = await db.prepRecipeItem.findMany({
      where: { prepIngredientId: id },
      select: { componentIngredientId: true, quantity: true },
    });
    if (!recipe.length) {
      throw new BadRequestException('Set a recipe before preparing a batch');
    }

    const planned = dto.quantity;
    const actual = dto.actualQuantity ?? planned;
    // Scale the standard recipe to the planned yield; drop components that round
    // to nothing (a zero movement is meaningless in the ledger).
    const components = scaleComponents(
      recipe.map((r) => ({
        ingredientId: r.componentIngredientId,
        quantity: r.quantity,
      })),
      item.prepBatchYield,
      planned,
    ).filter((c) => c.quantity > 0);

    // BLOCK on a shortfall — with names + amounts in the message, so the kitchen
    // sees exactly what is short. (The API's error filter keeps only `message`,
    // so the detail lives there; the prepare form also previews it client-side.)
    const stock = await stockByIngredient(db);
    const shorts = findShortfalls(components, stock);
    if (shorts.length) {
      const names = new Map(
        (
          await db.ingredient.findMany({
            where: { id: { in: shorts.map((s) => s.ingredientId) } },
            select: { id: true, name: true },
          })
        ).map((n) => [n.id, n.name]),
      );
      const detail = shorts
        .map(
          (s) =>
            `${names.get(s.ingredientId) ?? 'item'} (need ${s.need}, have ${s.available})`,
        )
        .join(', ');
      throw new BadRequestException(`Not enough stock: ${detail}`);
    }

    // Cost snapshot from the raw components actually consumed (null if any
    // component has no cost basis — never a fabricated zero).
    const cost = await costByIngredient(db);
    const costMinor = batchCost(components, cost);

    const now = new Date();
    const expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : item.prepShelfLifeHours != null
        ? new Date(now.getTime() + item.prepShelfLifeHours * 3600 * 1000)
        : null;

    const batch = await db.prepBatch.create({
      data: {
        restaurantId: ctx.restaurantId,
        prepIngredientId: id,
        code: batchCode(now),
        expectedQuantity: planned,
        actualQuantity: actual,
        expiresAt,
        costMinor,
        note: dto.note ?? null,
        actorUserId: ctx.userId,
        idempotencyKey: dto.idempotencyKey ?? null,
      },
      select: {
        id: true,
        code: true,
        expectedQuantity: true,
        actualQuantity: true,
        expiresAt: true,
        costMinor: true,
        createdAt: true,
      },
    });

    // Raw out (PREP_BATCH) + prepared in (PREP_OUTPUT), all tagged with the
    // batch so its remaining is SUM over these rows. A zero-yield batch (a
    // total loss) still consumes its raw and simply produces no output row.
    type PrepMovement = {
      restaurantId: string;
      ingredientId: string;
      type: 'PREP_BATCH' | 'PREP_OUTPUT';
      quantity: number;
      prepBatchId: string;
      actorUserId: string | null;
    };
    const rows: PrepMovement[] = components.map((c) => ({
      restaurantId: ctx.restaurantId,
      ingredientId: c.ingredientId,
      type: 'PREP_BATCH',
      quantity: -c.quantity,
      prepBatchId: batch.id,
      actorUserId: ctx.userId,
    }));
    if (actual > 0) {
      rows.push({
        restaurantId: ctx.restaurantId,
        ingredientId: id,
        type: 'PREP_OUTPUT',
        quantity: actual,
        prepBatchId: batch.id,
        actorUserId: ctx.userId,
      });
    }
    await db.stockMovement.createMany({ data: rows });

    return { ...batch, variance: yieldVariance(planned, actual) };
  }

  private findBatchByKey(idempotencyKey: string) {
    return this.prisma.tx((db) =>
      db.prepBatch.findFirst({
        where: { idempotencyKey },
        select: {
          id: true,
          code: true,
          expectedQuantity: true,
          actualQuantity: true,
          expiresAt: true,
          costMinor: true,
          createdAt: true,
        },
      }),
    );
  }

  /**
   * Wastes a quantity of a batch — a negative WASTE tagged with the batch, so it
   * draws that batch (and the item's stock) down auditably. Capped at what the
   * batch has left; you cannot waste more than remains.
   */
  async wasteBatch(batchId: string, dto: WasteBatchDto) {
    const ctx = this.prisma.requireContext();
    if (dto.idempotencyKey) {
      const existing = await this.findMovementByKey(dto.idempotencyKey);
      if (existing) return existing;
    }
    try {
      return await this.prisma.tx(async (db) => {
        const batch = await db.prepBatch.findFirst({
          where: { id: batchId },
          select: { id: true, prepIngredientId: true },
        });
        if (!batch) throw new NotFoundException('Batch not found');
        const remaining =
          (await remainingByBatch(db, [batchId])).get(batchId) ?? 0;
        if (dto.quantity > remaining) {
          throw new BadRequestException(
            `Only ${remaining} remaining in this batch`,
          );
        }
        return db.stockMovement.create({
          data: {
            restaurantId: ctx.restaurantId,
            ingredientId: batch.prepIngredientId,
            type: 'WASTE',
            quantity: -dto.quantity,
            prepBatchId: batchId,
            note: dto.note ?? null,
            actorUserId: ctx.userId,
            idempotencyKey: dto.idempotencyKey ?? null,
          },
          select: { id: true, type: true, quantity: true, createdAt: true },
        });
      });
    } catch (e) {
      if (dto.idempotencyKey && isUniqueViolation(e)) {
        const existing = await this.findMovementByKey(dto.idempotencyKey);
        if (existing) return existing;
      }
      throw e;
    }
  }

  private findMovementByKey(idempotencyKey: string) {
    return this.prisma.tx((db) =>
      db.stockMovement.findFirst({
        where: { idempotencyKey },
        select: { id: true, type: true, quantity: true, createdAt: true },
      }),
    );
  }
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002';
}
