import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService, type TxClient } from '../../prisma/prisma.service';
import { EventsService } from '../../events/events.service';
import { LoyaltyEntryType, OrderStatus } from '../../generated/prisma/enums';
import {
  STATUS_TYPES,
  nextTierFor,
  pointsForOrder,
  tierFor,
} from './loyalty.rules';
import type { AdjustPointsDto, RedeemPointsDto } from './dto/loyalty.dto';

/**
 * The loyalty ledger's one write path. Every method appends immutable rows and
 * derives balances by summing them — there is no cached balance to drift.
 *
 * Two invariants are enforced here rather than in the schema, because a derived
 * balance has no column to constrain:
 *   1. No negative balance. REDEEM and a negative ADJUST read the balance under
 *      a customer-row lock and refuse to overspend. REFUND_REVERSAL is the one
 *      exception — a refund may legitimately unwind points already spent.
 *   2. Idempotency. earn/reverse are unique per (order, type) at the DB; redeem
 *      /adjust carry a client key. A constraint violation aborts the Postgres
 *      transaction, so — exactly as OrdersService.recordPayment does — the
 *      unique race is caught OUTSIDE the tx and answered with a fresh read.
 */
@Injectable()
export class LoyaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  // -------------------------------------------------------------------- read

  /** A customer's balance, lifetime-earned, tier and recent entries. */
  async getSummary(customerId: string) {
    return this.prisma.tx(async (db) => {
      await this.assertCustomer(db, customerId);
      return this.summarize(db, customerId);
    });
  }

  // ------------------------------------------------------------------- earn

  /**
   * Credits the points an order earned, once. Idempotent: a replay finds the
   * existing EARN row (or loses the unique race) and reads back the summary
   * rather than crediting twice. This is the seam a future checkout calls; it
   * does not run automatically yet.
   */
  async earnForOrder(orderId: string) {
    const order = await this.prisma.tx((db) =>
      db.order.findFirst({
        where: { id: orderId },
        select: {
          customerId: true,
          status: true,
          subtotalMinor: true,
          discountMinor: true,
        },
      }),
    );
    if (!order) throw new NotFoundException('Order not found');
    // Anonymous walk-ins have no loyalty account; a reversed sale earns nothing.
    if (!order.customerId) {
      throw new BadRequestException('Order has no customer to credit');
    }
    if (
      order.status === OrderStatus.VOIDED ||
      order.status === OrderStatus.CANCELLED
    ) {
      throw new BadRequestException(
        'A voided or cancelled order earns no points',
      );
    }
    const customerId = order.customerId;
    const points = pointsForOrder(order);

    try {
      return await this.prisma.tx(async (db) => {
        const existing = await db.loyaltyLedger.findFirst({
          where: { orderId, type: LoyaltyEntryType.EARN },
          select: { id: true },
        });
        if (existing || points <= 0) return this.summarize(db, customerId);
        await this.append(db, {
          customerId,
          type: LoyaltyEntryType.EARN,
          points,
          orderId,
          action: 'loyalty.earned',
        });
        return this.summarize(db, customerId);
      });
    } catch (e) {
      // A concurrent earn for this order won the unique index — its row is ours.
      if (isUniqueViolation(e)) return this.getSummary(customerId);
      throw e;
    }
  }

  /**
   * Reverses the full points an order earned, once, when that sale is refunded.
   * Idempotent per (order, REFUND_REVERSAL). Deliberately allowed to push the
   * balance negative: the customer may already have spent points this now
   * unwinds, and the honest record of that is a negative balance, not a lie.
   */
  async reverseForOrder(orderId: string) {
    const earn = await this.prisma.tx((db) =>
      db.loyaltyLedger.findFirst({
        where: { orderId, type: LoyaltyEntryType.EARN },
        select: { customerId: true, points: true },
      }),
    );
    if (!earn) {
      throw new NotFoundException('No earned points to reverse for this order');
    }
    const customerId = earn.customerId;

    try {
      return await this.prisma.tx(async (db) => {
        const already = await db.loyaltyLedger.findFirst({
          where: { orderId, type: LoyaltyEntryType.REFUND_REVERSAL },
          select: { id: true },
        });
        if (already) return this.summarize(db, customerId);
        await this.append(db, {
          customerId,
          type: LoyaltyEntryType.REFUND_REVERSAL,
          points: -earn.points,
          orderId,
          action: 'loyalty.refund_reversed',
        });
        return this.summarize(db, customerId);
      });
    } catch (e) {
      if (isUniqueViolation(e)) return this.getSummary(customerId);
      throw e;
    }
  }

  // ------------------------------------------------------------- redemption

  /**
   * Spends points to fund an order's discount, INSIDE the caller's order
   * transaction — so the sale and the debit commit together or not at all. Locks
   * the customer (held to the caller's commit, serializing concurrent
   * redemptions), refuses to overspend, and appends one order-tied REDEEM. The
   * discount itself belongs to OrdersService; this is the debit and its record.
   */
  async redeemForOrder(
    db: TxClient,
    customerId: string,
    orderId: string,
    points: number,
  ): Promise<void> {
    const actorUserId = this.prisma.requireContext().userId ?? null;
    await this.lockCustomer(db, customerId);
    const balance = await this.balance(db, customerId);
    if (points > balance) {
      throw new BadRequestException('Not enough points to redeem');
    }
    await this.append(db, {
      customerId,
      type: LoyaltyEntryType.REDEEM,
      points: -points,
      orderId,
      actorUserId,
      action: 'loyalty.redeemed',
    });
  }

  /**
   * Restores the points a refunded order's redemption spent, once. Idempotent
   * per (order, REDEEM_REVERSAL). A POSITIVE, balance-only entry — not a status
   * type — so restoring never inflates lifetime-earned or tier (the REDEEM it
   * undoes never lowered them). The symmetric counterpart to reverseForOrder.
   * An order that redeemed nothing is a no-op.
   */
  async restoreRedeemedForOrder(orderId: string) {
    const redeem = await this.prisma.tx((db) =>
      db.loyaltyLedger.findFirst({
        where: { orderId, type: LoyaltyEntryType.REDEEM },
        select: { customerId: true, points: true },
      }),
    );
    if (!redeem) return null; // nothing was redeemed on this order
    const customerId = redeem.customerId;

    try {
      return await this.prisma.tx(async (db) => {
        const already = await db.loyaltyLedger.findFirst({
          where: { orderId, type: LoyaltyEntryType.REDEEM_REVERSAL },
          select: { id: true },
        });
        if (already) return this.summarize(db, customerId);
        await this.append(db, {
          customerId,
          type: LoyaltyEntryType.REDEEM_REVERSAL,
          points: -redeem.points, // REDEEM is negative → the restore is positive
          orderId,
          action: 'loyalty.redeem_restored',
        });
        return this.summarize(db, customerId);
      });
    } catch (e) {
      if (isUniqueViolation(e)) return this.getSummary(customerId);
      throw e;
    }
  }

  // ----------------------------------------------------------------- redeem

  /** Spends points. Serialized per customer; never overspends. */
  async redeem(customerId: string, dto: RedeemPointsDto) {
    const actorUserId = this.prisma.requireContext().userId ?? null;
    try {
      return await this.prisma.tx(async (db) => {
        // Lock first, THEN check for a replay: the lock serializes same-customer
        // redeems, so a retry that slips in after the first commit sees the row.
        await this.lockCustomer(db, customerId);
        const replay = await this.replay(db, customerId, dto.idempotencyKey);
        if (replay) return replay;

        const balance = await this.balance(db, customerId);
        if (dto.points > balance) {
          throw new BadRequestException('Not enough points to redeem');
        }
        await this.append(db, {
          customerId,
          type: LoyaltyEntryType.REDEEM,
          points: -dto.points,
          reason: dto.reason ?? null,
          actorUserId,
          idempotencyKey: dto.idempotencyKey ?? null,
          action: 'loyalty.redeemed',
        });
        return this.summarize(db, customerId);
      });
    } catch (e) {
      if (dto.idempotencyKey && isUniqueViolation(e)) {
        return this.getSummary(customerId);
      }
      throw e;
    }
  }

  /** Manual signed correction or goodwill grant. Never drives balance below zero. */
  async adjust(customerId: string, dto: AdjustPointsDto) {
    const actorUserId = this.prisma.requireContext().userId ?? null;
    try {
      return await this.prisma.tx(async (db) => {
        await this.lockCustomer(db, customerId);
        const replay = await this.replay(db, customerId, dto.idempotencyKey);
        if (replay) return replay;

        if (dto.points < 0) {
          const balance = await this.balance(db, customerId);
          if (balance + dto.points < 0) {
            throw new BadRequestException(
              'Adjustment would drive the balance below zero',
            );
          }
        }
        await this.append(db, {
          customerId,
          type: LoyaltyEntryType.ADJUST,
          points: dto.points,
          reason: dto.reason,
          actorUserId,
          idempotencyKey: dto.idempotencyKey ?? null,
          action: 'loyalty.adjusted',
        });
        return this.summarize(db, customerId);
      });
    } catch (e) {
      if (dto.idempotencyKey && isUniqueViolation(e)) {
        return this.getSummary(customerId);
      }
      throw e;
    }
  }

  // -------------------------------------------------------------- internals

  private async assertCustomer(db: TxClient, customerId: string) {
    const c = await db.customer.findFirst({
      where: { id: customerId },
      select: { id: true },
    });
    // Another tenant's customer does not exist here (RLS) — same 404 as unknown.
    if (!c) throw new NotFoundException('Customer not found');
  }

  /**
   * Row lock that serializes concurrent redeem/adjust for one customer, so the
   * read-balance-then-append cannot race two debits past zero. RLS scopes the
   * row to this tenant; no row means it is not ours (or does not exist).
   */
  private async lockCustomer(db: TxClient, customerId: string) {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM customers WHERE id = ${customerId}::uuid FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Customer not found');
  }

  private async balance(db: TxClient, customerId: string): Promise<number> {
    const agg = await db.loyaltyLedger.aggregate({
      where: { customerId },
      _sum: { points: true },
    });
    return agg._sum.points ?? 0;
  }

  /** A replayed idempotency key returns the current summary instead of writing. */
  private async replay(db: TxClient, customerId: string, key?: string) {
    if (!key) return null;
    const hit = await db.loyaltyLedger.findFirst({
      where: { idempotencyKey: key },
      select: { id: true },
    });
    return hit ? this.summarize(db, customerId) : null;
  }

  private async append(
    db: TxClient,
    e: {
      customerId: string;
      type: LoyaltyEntryType;
      points: number;
      orderId?: string | null;
      reason?: string | null;
      actorUserId?: string | null;
      idempotencyKey?: string | null;
      action: string;
    },
  ) {
    const ctx = this.prisma.requireContext();
    await db.loyaltyLedger.create({
      data: {
        restaurantId: ctx.restaurantId,
        customerId: e.customerId,
        type: e.type,
        points: e.points,
        orderId: e.orderId ?? null,
        reason: e.reason ?? null,
        actorUserId: e.actorUserId ?? null,
        idempotencyKey: e.idempotencyKey ?? null,
      },
    });
    // The M0 event seam: loyalty is a tenant activity the Timeline/History will
    // read. entityId is the customer; metadata carries ids and amounts, no PII.
    await this.events.record(db, {
      action: e.action,
      entityType: 'customer',
      entityId: e.customerId,
      metadata: {
        type: e.type,
        points: e.points,
        ...(e.orderId ? { orderId: e.orderId } : {}),
      },
    });
  }

  /** Everything derivable from one grouped sum plus a recent-rows read. */
  private async summarize(db: TxClient, customerId: string) {
    const groups = await db.loyaltyLedger.groupBy({
      by: ['type'],
      where: { customerId },
      _sum: { points: true },
    });
    let balancePoints = 0;
    let lifetimeEarnedPoints = 0;
    let redeemedPoints = 0;
    for (const g of groups) {
      const sum = g._sum.points ?? 0;
      balancePoints += sum;
      if (STATUS_TYPES.includes(g.type)) lifetimeEarnedPoints += sum;
      if (g.type === LoyaltyEntryType.REDEEM) redeemedPoints += -sum;
    }
    const recentEntries = await db.loyaltyLedger.findMany({
      where: { customerId },
      take: 10,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        points: true,
        orderId: true,
        reason: true,
        createdAt: true,
      },
    });

    const tier = tierFor(lifetimeEarnedPoints);
    return {
      customerId,
      balancePoints,
      lifetimeEarnedPoints,
      redeemedPoints,
      tier: { key: tier.key, label: tier.label, minPoints: tier.minPoints },
      nextTier: nextTierFor(lifetimeEarnedPoints),
      recentEntries,
    };
  }
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002';
}
