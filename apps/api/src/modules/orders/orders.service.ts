import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService, type TxClient } from '../../prisma/prisma.service';
import type { CreateOrderDto } from './dto/create-order.dto';
import type { OrderStatus } from '../../generated/prisma/enums';
import { VOID_STATUSES, canTransition } from './order-status';
import { InventoryService } from '../inventory/inventory.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { MarketingService } from '../marketing/marketing.service';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly realtime: RealtimeGateway,
    private readonly marketing: MarketingService,
  ) {}

  /**
   * Places an order.
   *
   * Every price is read from the database inside the transaction. The client
   * says what was ordered; the server decides what it costs. This is the
   * difference between a POS and a donation box.
   */
  async create(dto: CreateOrderDto) {
    const ctx = this.prisma.requireContext();

    // An idempotent replay must return the original order, not a second one.
    if (dto.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(dto.idempotencyKey);
      if (existing) return existing;
    }

    // Retry only on order_number collision (below). Anything else propagates.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const order = await this.insert(ctx.restaurantId, ctx.userId, dto);
        // Emit AFTER commit: an event fired inside the transaction would
        // announce an order to the kitchen that a rollback then erased. Scoped
        // to this tenant's room only.
        this.realtime.emitToTenant(ctx.restaurantId, 'order.created', {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
        });
        return order;
      } catch (e) {
        if (isUniqueViolation(e, 'order_number')) continue;
        throw e;
      }
    }
    throw new BadRequestException('Could not allocate an order number');
  }

  private async insert(
    restaurantId: string,
    userId: string,
    dto: CreateOrderDto,
  ) {
    return this.prisma.tx(async (db) => {
      // RLS scopes this to the tenant, so a productId belonging to another
      // restaurant simply is not found — cross-tenant ordering fails as
      // "unknown product" rather than needing a check we might forget.
      const ids = [...new Set(dto.items.map((i) => i.productId))];
      const products = await db.product.findMany({
        where: { id: { in: ids }, isActive: true },
        select: { id: true, name: true, priceMinor: true, taxRateBp: true },
      });

      const byId = new Map(products.map((p) => [p.id, p]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length) {
        // Deliberately vague: do not confirm whether an id exists elsewhere.
        throw new BadRequestException('One or more products are unavailable');
      }

      // A customerId from the client is verified, never trusted. RLS scopes
      // this lookup to the tenant, so another restaurant's customer simply is
      // not found — attaching one is impossible rather than merely discouraged.
      if (dto.customerId) {
        const customer = await db.customer.findFirst({
          where: { id: dto.customerId },
          select: { id: true },
        });
        if (!customer) {
          throw new BadRequestException('Unknown customer');
        }
      }

      const branch = await db.branch.findFirstOrThrow({
        where: { isActive: true },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });

      // --- money, in integer paise throughout
      const lines = dto.items.map((item) => {
        const p = byId.get(item.productId)!;
        const lineTotal = p.priceMinor * item.quantity;
        // Round half-up at the line, matching how a printed receipt reads.
        const tax = Math.round((lineTotal * p.taxRateBp) / 10_000);
        return {
          productId: p.id,
          nameSnapshot: p.name,
          unitPriceMinor: p.priceMinor,
          quantity: item.quantity,
          lineTotalMinor: lineTotal,
          taxRateBp: p.taxRateBp,
          taxMinor: tax,
          notes: item.notes ?? null,
        };
      });

      const subtotal = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
      const tax = lines.reduce((s, l) => s + l.taxMinor, 0);

      // Coupon discount, computed server-side inside this transaction. The
      // client sends only a code — never an amount — so it can never dictate
      // the discount. A bad/expired/exhausted code is rejected, not silently
      // ignored, so the cashier knows it did not apply.
      let discount = 0;
      let couponRedemption: { couponId: string; discountMinor: number } | null =
        null;
      if (dto.couponCode) {
        const result = await this.marketing.validateAndComputeDiscount(
          db,
          dto.couponCode,
          subtotal,
        );
        if (!result.ok) throw new BadRequestException(result.reason);
        discount = result.discountMinor;
        couponRedemption = {
          couponId: result.couponId,
          discountMinor: result.discountMinor,
        };
      }

      // total = subtotal - discount + tax. The DB CHECK enforces this exact
      // identity and that discount <= subtotal, so a computation bug fails the
      // insert rather than surfacing in a GST return.
      const total = subtotal - discount + tax;

      // Per-tenant sequence. RLS already scopes the aggregate to this tenant,
      // so no restaurantId filter is needed. Two concurrent orders can pick the
      // same number; the unique index rejects the loser and create() retries.
      const last = await db.order.aggregate({ _max: { orderNumber: true } });
      const orderNumber = (last._max.orderNumber ?? 0) + 1;

      const order = await db.order.create({
        data: {
          restaurantId,
          branchId: branch.id,
          customerId: dto.customerId ?? null,
          orderNumber,
          status: 'PLACED',
          placedAt: new Date(),
          subtotalMinor: subtotal,
          discountMinor: discount,
          taxMinor: tax,
          totalMinor: total,
          notes: dto.notes ?? null,
          items: { create: lines.map((l) => ({ restaurantId, ...l })) },
        },
        select: { id: true, orderNumber: true, totalMinor: true },
      });

      // Record the redemption (append-only) now that the order exists.
      if (couponRedemption) {
        await this.marketing.recordRedemption(
          db,
          restaurantId,
          couponRedemption.couponId,
          order.id,
          couponRedemption.discountMinor,
        );
      }

      if (dto.paymentMethod) {
        await db.payment.create({
          data: {
            restaurantId,
            orderId: order.id,
            method: dto.paymentMethod,
            // Cash and UPI are settled at the counter. Card/wallet gateways
            // arrive with a payments provider and will start PENDING.
            status: 'CAPTURED',
            amountMinor: total,
            idempotencyKey: dto.idempotencyKey ?? null,
          },
        });
      }

      // Stock depletion runs in the SAME transaction as the sale: either both
      // commit or neither does. A sale that succeeded while its stock movement
      // failed would silently corrupt food cost.
      //
      // This does NOT block on insufficient stock — see depleteForOrder.
      await this.inventory.depleteForOrder(
        db,
        restaurantId,
        userId,
        order.id,
        dto.items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
        })),
      );

      // Append-only trail. This is what the order timeline reads.
      await db.orderEvent.create({
        data: {
          restaurantId,
          orderId: order.id,
          type: 'CREATED',
          toStatus: 'PLACED',
          actorUserId: userId,
          metadata: { itemCount: lines.length, totalMinor: total },
        },
      });

      return this.load(db, order.id);
    });
  }

  /** Recent orders, newest first, optionally filtered by status. */
  list(opts: { limit?: number; status?: OrderStatus } = {}) {
    const take = Math.min(opts.limit ?? 50, 100);
    return this.prisma.tx((db) =>
      db.order.findMany({
        take,
        // RLS scopes this to the tenant; there is deliberately no
        // `where: { restaurantId }` that could be forgotten.
        where: opts.status ? { status: opts.status } : undefined,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          totalMinor: true,
          createdAt: true,
          placedAt: true,
          _count: { select: { items: true } },
        },
      }),
    );
  }

  /**
   * The order timeline — the append-only trail of what happened and who did it.
   *
   * This is the evidence in a dispute, which is precisely why order_events
   * cannot be updated or deleted by anyone short of dropping the trigger.
   */
  async timeline(orderId: string) {
    return this.prisma.tx(async (db) => {
      // Confirm the order is visible to this tenant first. Without it, an
      // attacker could read another tenant's events by id — the events table
      // is RLS-protected too, but relying on a second table's policy for a
      // check this cheap is how holes appear.
      const order = await db.order.findFirst({
        where: { id: orderId },
        select: { id: true },
      });
      if (!order) throw new NotFoundException('Order not found');

      return db.orderEvent.findMany({
        where: { orderId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          type: true,
          fromStatus: true,
          toStatus: true,
          actorUserId: true,
          metadata: true,
          createdAt: true,
        },
      });
    });
  }

  /**
   * Moves an order through its lifecycle.
   *
   * Two independent gates:
   *   1. The state machine (order-status.ts) — is this move legal at all?
   *   2. The permission (checked in the controller) — may THIS user make it?
   *
   * Both are needed. A cashier with order.update must not be able to jump
   * PLACED -> COMPLETED and skip payment; a manager with order.void must still
   * not be able to un-void.
   */
  async updateStatus(
    orderId: string,
    to: OrderStatus,
    reason?: string,
    opts: { requireVoidPermission?: boolean } = {},
  ) {
    const ctx = this.prisma.requireContext();

    // Voiding reverses money that was already rung up — the classic way a
    // cashier makes a sale disappear. order.update is not enough.
    if (opts.requireVoidPermission && !ctx.permissions.includes('order.void')) {
      throw new ForbiddenException('Missing permission: order.void');
    }

    // Whether an actual transition happened, decided inside the tx and read
    // after it, so the realtime emit only fires on a real change post-commit.
    let changed = false;

    const result = await this.prisma.tx(async (db) => {
      const order = await db.order.findFirst({
        where: { id: orderId },
        select: { id: true, status: true, orderNumber: true },
      });
      // Another tenant's order does not exist here. Same 404 as a bad id, so
      // this cannot be used to probe which ids are real.
      if (!order) throw new NotFoundException('Order not found');

      const from = order.status;
      if (from === to) {
        // Idempotent: a double-tapped button is not an error.
        return this.load(db, orderId);
      }
      changed = true;

      if (!canTransition(from, to)) {
        throw new ConflictException(
          `Cannot move an order from ${from} to ${to}`,
        );
      }

      await db.order.update({
        where: { id: orderId },
        // Only status. The money columns are frozen by trigger anyway, but not
        // touching them is the honest expression of intent.
        data: { status: to },
      });

      await db.orderEvent.create({
        data: {
          restaurantId: ctx.restaurantId,
          orderId,
          type: 'STATUS_CHANGED',
          fromStatus: from,
          toStatus: to,
          actorUserId: ctx.userId,
          metadata: reason ? { reason } : undefined,
        },
      });

      // Voids are the theft vector, so they also land in the tenant audit log
      // — the record an owner reviews, separate from the order's own timeline.
      if (VOID_STATUSES.includes(to)) {
        await db.auditLog.create({
          data: {
            restaurantId: ctx.restaurantId,
            userId: ctx.userId,
            action: 'order.voided',
            entityType: 'order',
            entityId: orderId,
            metadata: {
              orderNumber: order.orderNumber,
              reason: reason ?? null,
            },
          },
        });
      }

      return this.load(db, orderId);
    });

    // Post-commit, real-change-only. The kitchen screen advances live.
    if (changed) {
      this.realtime.emitToTenant(ctx.restaurantId, 'order.status_changed', {
        id: result.id,
        orderNumber: result.orderNumber,
        status: result.status,
      });
    }
    return result;
  }

  async getById(id: string) {
    try {
      return await this.prisma.tx((db) => this.load(db, id));
    } catch (e) {
      // RLS makes another tenant's order simply not exist, so Prisma raises
      // "record not found". Surface that as 404, not a 500 — and note it is
      // the SAME response as a genuinely unknown id, so this cannot be used to
      // probe which order ids are real.
      if ((e as { code?: string })?.code === 'P2025') {
        throw new NotFoundException('Order not found');
      }
      throw e;
    }
  }

  private async findByIdempotencyKey(key: string) {
    return this.prisma.tx(async (db) => {
      const payment = await db.payment.findFirst({
        where: { idempotencyKey: key },
        select: { orderId: true },
      });
      return payment ? this.load(db, payment.orderId) : null;
    });
  }

  private load(db: TxClient, id: string) {
    // findFirst, not findUnique: RLS returns nothing for another tenant's id,
    // so this 404s rather than leaking existence.
    return db.order.findFirstOrThrow({
      where: { id },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        subtotalMinor: true,
        discountMinor: true,
        taxMinor: true,
        totalMinor: true,
        currency: true,
        notes: true,
        placedAt: true,
        createdAt: true,
        items: {
          select: {
            id: true,
            nameSnapshot: true,
            unitPriceMinor: true,
            quantity: true,
            lineTotalMinor: true,
            taxMinor: true,
            notes: true,
          },
        },
        payments: {
          select: { id: true, method: true, status: true, amountMinor: true },
        },
        customer: { select: { id: true, name: true, phone: true } },
      },
    });
  }
}

function isUniqueViolation(e: unknown, field: string): boolean {
  const err = e as {
    code?: string;
    meta?: {
      target?: unknown;
      driverAdapterError?: { cause?: { originalMessage?: string } };
    };
  };
  if (err?.code !== 'P2002') return false;
  const target = err.meta?.target;
  if (Array.isArray(target) && target.some((t) => String(t).includes(field))) {
    return true;
  }
  const msg = err.meta?.driverAdapterError?.cause?.originalMessage;
  return typeof msg === 'string' && msg.includes(field);
}
