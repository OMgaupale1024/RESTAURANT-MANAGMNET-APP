import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService, type TxClient } from '../../prisma/prisma.service';
import { EventsService } from '../../events/events.service';
import type { StockCountReason } from '../../generated/prisma/enums';
import { stockByIngredient } from './stock-queries';
import { countCode, missingReasons, reconcileCount } from './stock-count';
import type {
  StartStockCountDto,
  SubmitStockCountDto,
} from './dto/stock-count.dto';

/** Human labels for the movement note left on each adjustment. */
const REASON_LABEL: Record<StockCountReason, string> = {
  WASTE_SPOILAGE: 'Waste / spoilage',
  COUNTING_ERROR: 'Counting error',
  DAMAGED: 'Damaged',
  THEFT: 'Theft / missing',
  UNRECORDED_USAGE: 'Unrecorded usage',
  RECEIVING_DISCREPANCY: 'Receiving discrepancy',
  OTHER: 'Other',
};

/**
 * Physical stock counts. A count is the WORKFLOW around inventory's existing
 * ADJUSTMENT movement: it snapshots system stock when it starts, collects what
 * staff physically counted, and on submit turns each discrepancy into one signed
 * ADJUSTMENT on the SAME ledger — reconciled against LIVE stock so a sale during
 * the count is never double-counted (the maths is in stock-count.ts). There is
 * no second adjustment ledger and no mutable stock counter; current stock stays
 * SUM(stock_movements), as everywhere else in inventory.
 */
@Injectable()
export class StockCountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  /**
   * Starts a count and snapshots system stock for the chosen ingredients. Scope:
   * an explicit `ingredientIds` set, everything flagged low (`lowStockOnly`), or
   * — the default — every active ingredient, raw and prepared alike (§9).
   */
  async start(dto: StartStockCountDto) {
    const ctx = this.prisma.requireContext();

    return this.retryOnCodeClash(() =>
      this.prisma.tx(async (db) => {
        const ingredients = await this.resolveScope(db, dto);
        if (!ingredients.length) {
          throw new BadRequestException('No ingredients to count');
        }

        // Snapshot: SUM(movements) at start, per chosen ingredient. This is what
        // staff saw; the submit reconciles against live stock, not this.
        const stock = await stockByIngredient(db);

        const count = await db.stockCount.create({
          data: {
            restaurantId: ctx.restaurantId,
            code: countCode(new Date()),
            notes: dto.notes ?? null,
            createdBy: ctx.userId,
            lines: {
              create: ingredients.map((i) => ({
                restaurantId: ctx.restaurantId,
                ingredientId: i.id,
                systemQuantity: stock.get(i.id) ?? 0,
              })),
            },
          },
          select: { id: true },
        });

        return this.loadDetail(db, count.id);
      }),
    );
  }

  /** Recent counts, newest first — the count history index (§22). */
  list() {
    return this.prisma.tx((db) =>
      db.stockCount.findMany({
        orderBy: { startedAt: 'desc' },
        take: 50,
        select: {
          id: true,
          code: true,
          status: true,
          notes: true,
          startedAt: true,
          completedAt: true,
          _count: { select: { lines: true } },
        },
      }),
    );
  }

  /** One count with its lines and each line's current live stock. */
  async getById(id: string) {
    return this.prisma.tx(async (db) => {
      const detail = await this.loadDetail(db, id);
      if (!detail) throw new NotFoundException('Stock count not found');
      return detail;
    });
  }

  /**
   * Submits a count: reconciles each physical count against LIVE stock, writes
   * one signed ADJUSTMENT per non-zero discrepancy, records the counted values on
   * the lines and completes the count — all in ONE transaction, so either the
   * whole count applies or nothing does (§19).
   *
   * Idempotent (§20): a row-level lock serialises concurrent submits, and a
   * second submit of an already-COMPLETED count returns the completed result
   * without writing anything again. Because live stock is read INSIDE the locked
   * transaction, any movement that landed during the count is already reflected,
   * so the adjustment is correct under concurrency (§6).
   */
  async submit(id: string, dto: SubmitStockCountDto) {
    const ctx = this.prisma.requireContext();

    return this.prisma.tx(async (db) => {
      // Lock the count row first — the guard against a double submit racing.
      await db.$queryRaw`SELECT id FROM stock_counts WHERE id = ${id}::uuid FOR UPDATE`;

      const count = await db.stockCount.findFirst({
        where: { id },
        select: {
          id: true,
          code: true,
          status: true,
          lines: { select: { id: true, ingredientId: true } },
        },
      });
      if (!count) throw new NotFoundException('Stock count not found');

      // Already applied → return it unchanged. This is the idempotent replay:
      // a retried submit never writes a second set of adjustments.
      if (count.status === 'COMPLETED') {
        return (await this.loadDetail(db, id))!;
      }
      if (count.status !== 'OPEN') {
        throw new ConflictException('This count can no longer be submitted');
      }

      const lineByIngredient = new Map(
        count.lines.map((l) => [l.ingredientId, l.id]),
      );
      const seen = new Set<string>();
      for (const l of dto.lines) {
        if (!lineByIngredient.has(l.ingredientId)) {
          throw new BadRequestException(
            'A counted item is not part of this count',
          );
        }
        if (seen.has(l.ingredientId)) {
          throw new BadRequestException('An item was counted twice');
        }
        seen.add(l.ingredientId);
      }

      // Reconcile against live stock read HERE, inside the lock.
      const live = await stockByIngredient(db);
      const adjustments = reconcileCount(
        dto.lines.map((l) => ({
          ingredientId: l.ingredientId,
          countedQuantity: l.countedQuantity,
          reason: l.reason ?? null,
        })),
        live,
      );

      const missing = missingReasons(adjustments);
      if (missing.length) {
        const names = await db.ingredient.findMany({
          where: { id: { in: missing } },
          select: { name: true },
        });
        throw new BadRequestException(
          `A reason is required where stock changed: ${names.map((n) => n.name).join(', ')}`,
        );
      }

      // One signed ADJUSTMENT per non-zero discrepancy — the movement type that
      // already means "a stock count correcting reality". The note carries the
      // count code + reason, so it reads correctly in the ingredient's ledger
      // (§18, §22). A zero difference writes nothing (§4) — and the DB
      // quantity-nonzero CHECK would reject it anyway.
      const moved = adjustments.filter((a) => a.difference !== 0);
      if (moved.length) {
        await db.stockMovement.createMany({
          data: moved.map((a) => ({
            restaurantId: ctx.restaurantId,
            ingredientId: a.ingredientId,
            type: 'ADJUSTMENT' as const,
            quantity: a.difference,
            note: `Stock count ${count.code} · ${REASON_LABEL[a.reason as StockCountReason]}`,
            actorUserId: ctx.userId,
          })),
        });
      }

      // Record what was counted onto each submitted line. Lines left uncounted
      // keep countedQuantity null — honestly "not counted", no adjustment.
      for (const a of adjustments) {
        await db.stockCountLine.update({
          where: { id: lineByIngredient.get(a.ingredientId)! },
          data: {
            countedQuantity: a.countedQuantity,
            difference: a.difference,
            reason: a.reason ?? null,
          },
        });
      }

      await db.stockCount.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          submittedBy: ctx.userId,
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
      });

      await this.events.record(db, {
        action: 'stockcount.completed',
        entityType: 'stock_count',
        entityId: id,
        metadata: {
          code: count.code,
          counted: adjustments.length,
          adjusted: moved.length,
        },
      });

      return (await this.loadDetail(db, id))!;
    });
  }

  /** Abandons an open count. Writes no stock; terminal. */
  async cancel(id: string) {
    return this.prisma.tx(async (db) => {
      await db.$queryRaw`SELECT id FROM stock_counts WHERE id = ${id}::uuid FOR UPDATE`;
      const count = await db.stockCount.findFirst({
        where: { id },
        select: { id: true, code: true, status: true },
      });
      if (!count) throw new NotFoundException('Stock count not found');
      if (count.status !== 'OPEN') {
        throw new ConflictException('Only an open count can be cancelled');
      }
      await db.stockCount.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });
      await this.events.record(db, {
        action: 'stockcount.cancelled',
        entityType: 'stock_count',
        entityId: id,
        metadata: { code: count.code },
      });
      return (await this.loadDetail(db, id))!;
    });
  }

  // -- helpers ---------------------------------------------------------------

  /** The ingredients a starting count covers, honouring its scope. */
  private async resolveScope(db: TxClient, dto: StartStockCountDto) {
    if (dto.ingredientIds?.length) {
      const ids = [...new Set(dto.ingredientIds)];
      // RLS scopes this — another tenant's ingredient is simply not found.
      const found = await db.ingredient.findMany({
        where: { id: { in: ids }, isActive: true },
        select: { id: true },
      });
      if (found.length !== ids.length) {
        throw new BadRequestException('One or more items are unavailable');
      }
      return found;
    }

    const active = await db.ingredient.findMany({
      where: { isActive: true },
      select: { id: true, reorderLevel: true },
      orderBy: { name: 'asc' },
    });
    if (!dto.lowStockOnly) return active.map((i) => ({ id: i.id }));

    const stock = await stockByIngredient(db);
    return active
      .filter(
        (i) =>
          i.reorderLevel !== null && (stock.get(i.id) ?? 0) <= i.reorderLevel,
      )
      .map((i) => ({ id: i.id }));
  }

  /** A count with its lines joined to ingredient name/unit and current stock. */
  private async loadDetail(db: TxClient, id: string) {
    const count = await db.stockCount.findFirst({
      where: { id },
      select: {
        id: true,
        code: true,
        status: true,
        notes: true,
        startedAt: true,
        completedAt: true,
        lines: {
          orderBy: { ingredient: { name: 'asc' } },
          select: {
            id: true,
            ingredientId: true,
            systemQuantity: true,
            countedQuantity: true,
            difference: true,
            reason: true,
            ingredient: { select: { name: true, unit: true } },
          },
        },
      },
    });
    if (!count) return null;

    const stock = await stockByIngredient(db);
    return {
      id: count.id,
      code: count.code,
      status: count.status,
      notes: count.notes,
      startedAt: count.startedAt,
      completedAt: count.completedAt,
      lines: count.lines.map((l) => ({
        id: l.id,
        ingredientId: l.ingredientId,
        name: l.ingredient.name,
        unit: l.ingredient.unit,
        systemQuantity: l.systemQuantity,
        currentStock: stock.get(l.ingredientId) ?? 0,
        countedQuantity: l.countedQuantity,
        difference: l.difference,
        reason: l.reason,
      })),
    };
  }

  /**
   * Retries the human count code's tiny collision chance with a fresh random
   * code, exactly like PrepService.createBatch. The uuid is the real key.
   */
  private async retryOnCodeClash<T>(write: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await write();
      } catch (e) {
        if ((e as { code?: string })?.code === 'P2002') continue;
        throw e;
      }
    }
    throw new ConflictException('Could not allocate a count code — try again');
  }
}
