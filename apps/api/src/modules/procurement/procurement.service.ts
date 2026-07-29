import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventsService } from '../../events/events.service';
import { InventoryService } from '../inventory/inventory.service';
import type {
  CreatePurchaseOrderDto,
  TransitionPurchaseOrderDto,
} from './dto/procurement.dto';

/** The purchase-order lifecycle whitelist. RECEIVED and CANCELLED are terminal. */
const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ORDERED', 'CANCELLED'],
  ORDERED: ['RECEIVED', 'CANCELLED'],
  RECEIVED: [],
  CANCELLED: [],
};

const PO_SELECT = {
  id: true,
  status: true,
  note: true,
  orderedAt: true,
  receivedAt: true,
  createdAt: true,
  supplier: { select: { id: true, name: true } },
  items: {
    select: {
      id: true,
      quantity: true,
      totalCostMinor: true,
      ingredient: { select: { id: true, name: true, unit: true } },
    },
  },
} as const;

@Injectable()
export class ProcurementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly inventory: InventoryService,
  ) {}

  /**
   * Drafts a purchase order. Validates the supplier and every ingredient belong
   * to the tenant (RLS scopes the reads; a missing row is simply "not found").
   * Records a `po.created` tenant event so it shows on the Timeline.
   */
  async createPurchaseOrder(dto: CreatePurchaseOrderDto) {
    const ctx = this.prisma.requireContext();
    const ids = [...new Set(dto.items.map((i) => i.ingredientId))];
    if (ids.length !== dto.items.length) {
      throw new BadRequestException('Duplicate ingredient in the order');
    }

    return this.prisma.tx(async (db) => {
      const supplier = await db.supplier.findFirst({
        where: { id: dto.supplierId },
        select: { id: true },
      });
      if (!supplier) throw new BadRequestException('Unknown supplier');

      const found = await db.ingredient.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      });
      if (found.length !== ids.length) {
        throw new BadRequestException('Unknown ingredient');
      }

      const po = await db.purchaseOrder.create({
        data: {
          restaurantId: ctx.restaurantId,
          supplierId: dto.supplierId,
          note: dto.note ?? null,
          actorUserId: ctx.userId,
          items: {
            create: dto.items.map((i) => ({
              restaurantId: ctx.restaurantId,
              ingredientId: i.ingredientId,
              quantity: i.quantity,
              totalCostMinor: i.totalCostMinor ?? null,
            })),
          },
        },
        select: PO_SELECT,
      });

      await this.events.record(db, {
        action: 'po.created',
        entityType: 'purchase_order',
        entityId: po.id,
        metadata: { supplierId: dto.supplierId, itemCount: dto.items.length },
      });
      return po;
    });
  }

  listPurchaseOrders(status?: string) {
    return this.prisma.tx((db) =>
      db.purchaseOrder.findMany({
        where: status ? { status: status as never } : undefined,
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          status: true,
          note: true,
          orderedAt: true,
          receivedAt: true,
          createdAt: true,
          supplier: { select: { id: true, name: true } },
          items: { select: { quantity: true, totalCostMinor: true } },
        },
      }),
    );
  }

  async getPurchaseOrder(id: string) {
    const po = await this.prisma.tx((db) =>
      db.purchaseOrder.findFirst({ where: { id }, select: PO_SELECT }),
    );
    if (!po) throw new NotFoundException('Purchase order not found');
    return po;
  }

  /**
   * Moves a purchase order along its lifecycle. RECEIVING is the meaningful
   * step: it writes ordinary PURCHASE `stock_movements` for every line — the
   * single source of what stock arrived and what it cost — inside the same
   * transaction as the status change, so stock and the PO commit together.
   *
   * A row-level lock serialises concurrent transitions on the same PO, so a
   * double-click on "Receive" cannot write the movements twice.
   */
  async transition(id: string, dto: TransitionPurchaseOrderDto) {
    const ctx = this.prisma.requireContext();
    const to = dto.status;

    return this.prisma.tx(async (db) => {
      // Lock the PO row first — the guard against a double receive racing.
      await db.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id}::uuid FOR UPDATE`;

      const po = await db.purchaseOrder.findFirst({
        where: { id },
        select: {
          id: true,
          status: true,
          supplierId: true,
          items: {
            select: {
              ingredientId: true,
              quantity: true,
              totalCostMinor: true,
            },
          },
        },
      });
      if (!po) throw new NotFoundException('Purchase order not found');

      if (!TRANSITIONS[po.status]?.includes(to)) {
        throw new ConflictException(
          `A ${po.status.toLowerCase()} order cannot move to ${to.toLowerCase()}`,
        );
      }

      if (to === 'RECEIVED') {
        if (!po.items.length) {
          throw new BadRequestException(
            'Cannot receive an order with no items',
          );
        }
        // Stock arrives as ordinary PURCHASE movements — nothing about the
        // arriving stock is stored twice; the PO was only the plan.
        await db.stockMovement.createMany({
          data: po.items.map((it) => ({
            restaurantId: ctx.restaurantId,
            ingredientId: it.ingredientId,
            type: 'PURCHASE' as const,
            quantity: it.quantity,
            supplierId: po.supplierId,
            totalCostMinor: it.totalCostMinor ?? null,
            actorUserId: ctx.userId,
            note: 'Received from purchase order',
          })),
        });
      }

      const updated = await db.purchaseOrder.update({
        where: { id },
        data: {
          status: to,
          ...(to === 'ORDERED' ? { orderedAt: new Date() } : {}),
          ...(to === 'RECEIVED' ? { receivedAt: new Date() } : {}),
        },
        select: PO_SELECT,
      });

      await this.events.record(db, {
        action: `po.${to.toLowerCase()}`,
        entityType: 'purchase_order',
        entityId: id,
        metadata: { supplierId: po.supplierId, itemCount: po.items.length },
      });
      return updated;
    });
  }

  /**
   * One row per active supplier, with its purchase history rolled up from the
   * PURCHASE stock movements (never a second purchase table): total spend, count,
   * last purchase, average days between purchases, and the ingredient bought most
   * by quantity. Suppliers never bought from show zeros — honest, not hidden.
   */
  async supplierInsights() {
    return this.prisma.tx(async (db) => {
      // Serial, not Promise.all: one tx, one pg connection (adapter-pg rule).
      const suppliers = await db.supplier.findMany({
        where: { isActive: true },
        select: { id: true, name: true, phone: true, preferred: true },
        orderBy: { name: 'asc' },
      });
      const agg = await db.stockMovement.groupBy({
        by: ['supplierId'],
        where: { type: 'PURCHASE', supplierId: { not: null } },
        _sum: { totalCostMinor: true },
        _count: { _all: true },
        _max: { createdAt: true },
        _min: { createdAt: true },
      });
      const perIngredient = await db.stockMovement.groupBy({
        by: ['supplierId', 'ingredientId'],
        where: { type: 'PURCHASE', supplierId: { not: null } },
        _sum: { quantity: true },
      });

      const aggBy = new Map(agg.map((g) => [g.supplierId, g]));
      const topBySupplier = new Map<
        string,
        { ingredientId: string; qty: number }
      >();
      for (const g of perIngredient) {
        if (!g.supplierId) continue;
        const qty = g._sum?.quantity ?? 0;
        const cur = topBySupplier.get(g.supplierId);
        if (!cur || qty > cur.qty) {
          topBySupplier.set(g.supplierId, {
            ingredientId: g.ingredientId,
            qty,
          });
        }
      }
      const topIngIds = [
        ...new Set([...topBySupplier.values()].map((v) => v.ingredientId)),
      ];
      const ings = topIngIds.length
        ? await db.ingredient.findMany({
            where: { id: { in: topIngIds } },
            select: { id: true, name: true },
          })
        : [];
      const ingName = new Map(ings.map((i) => [i.id, i.name]));

      return suppliers
        .map((s) => {
          const a = aggBy.get(s.id);
          const count = a?._count?._all ?? 0;
          const last = a?._max?.createdAt ?? null;
          const first = a?._min?.createdAt ?? null;
          const avgIntervalDays =
            count > 1 && first && last
              ? Math.round(
                  (last.getTime() - first.getTime()) /
                    ((count - 1) * 86_400_000),
                )
              : null;
          const top = topBySupplier.get(s.id);
          return {
            id: s.id,
            name: s.name,
            phone: s.phone,
            preferred: s.preferred,
            totalSpentMinor: a?._sum?.totalCostMinor ?? 0,
            purchaseCount: count,
            lastPurchaseAt: last,
            avgIntervalDays,
            topIngredient: top
              ? {
                  name: ingName.get(top.ingredientId) ?? '—',
                  quantity: top.qty,
                }
              : null,
          };
        })
        .sort((x, y) => y.totalSpentMinor - x.totalSpentMinor);
    });
  }

  /**
   * Reorder recommendations, only where confidence is high: the ingredients the
   * inventory already flags low (at/below their reorder level), each with a
   * suggested top-up quantity and the supplier last bought from. Reuses
   * `InventoryService.list` for the stock/usage figures — no recomputation.
   *
   * The suggestion is a transparent heuristic (top up to twice the reorder level
   * or about two weeks of recent usage, whichever is larger), never an opaque
   * "AI" number an owner cannot reason about.
   */
  async reorderSuggestions() {
    const low = await this.inventory.list({ lowStock: true });
    if (!low.length) return [];

    return this.prisma.tx(async (db) => {
      const ingIds = low.map((r) => r.id);
      const purchases = await db.stockMovement.findMany({
        where: {
          ingredientId: { in: ingIds },
          type: 'PURCHASE',
          supplierId: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        select: { ingredientId: true, supplierId: true },
      });
      const lastSupplierId = new Map<string, string>();
      for (const p of purchases) {
        if (p.supplierId && !lastSupplierId.has(p.ingredientId)) {
          lastSupplierId.set(p.ingredientId, p.supplierId);
        }
      }
      const supIds = [...new Set(lastSupplierId.values())];
      const suppliers = supIds.length
        ? await db.supplier.findMany({
            where: { id: { in: supIds } },
            select: { id: true, name: true, preferred: true },
          })
        : [];
      const supById = new Map(suppliers.map((s) => [s.id, s]));

      return low.map((r) => {
        const reorder = r.reorderLevel ?? 0;
        const target = Math.max(reorder * 2, Math.ceil(r.avgDailyUsage * 14));
        const suggestedQuantity = Math.max(target - r.currentStock, reorder, 1);
        const supId = lastSupplierId.get(r.id);
        const sup = supId ? supById.get(supId) : null;
        return {
          ingredientId: r.id,
          name: r.name,
          unit: r.unit,
          currentStock: r.currentStock,
          reorderLevel: r.reorderLevel,
          avgDailyUsage: r.avgDailyUsage,
          suggestedQuantity,
          lastSupplier: sup
            ? { id: sup.id, name: sup.name, preferred: sup.preferred }
            : null,
        };
      });
    });
  }
}
