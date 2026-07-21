import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../prisma/prisma.service';
import { OrderStatus } from '../../generated/prisma/enums';
import type { Prisma } from '../../generated/prisma/client';
import { AnalyticsService } from '../analytics/analytics.service';

/** IST is UTC+5:30. A "day" for an India-first business is an IST wall day. */
const IST_OFFSET = '+05:30';

/** A reversed sale did not happen — the same rule as everywhere else. */
const COUNTABLE: Prisma.OrderWhereInput['status'] = {
  notIn: [OrderStatus.VOIDED, OrderStatus.CANCELLED],
};

@Injectable()
export class ReportsService {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Sales for an explicit IST day window, inclusive of both ends.
   *
   * The figures are NOT recomputed here — this delegates to
   * AnalyticsService.overviewBetween, so a report total is by construction the
   * same number the dashboard shows for the same window.
   */
  async sales(fromStr: string, toStr: string) {
    const { from, to } = this.window(fromStr, toStr);
    return this.analytics.overviewBetween(from, to);
  }

  /**
   * GST collected, split by rate. Tax is summed from the per-line snapshots —
   * the same figures the receipt printed — so the report can never disagree
   * with what a customer was charged. (Tax is on pre-discount lines; see
   * BACKLOG #36.)
   */
  async gst(fromStr: string, toStr: string) {
    const { from, to } = this.window(fromStr, toStr);
    return this.prisma.tx(async (db) => {
      const grouped = await db.orderItem.groupBy({
        by: ['taxRateBp'],
        where: {
          order: { status: COUNTABLE, createdAt: { gte: from, lte: to } },
        },
        _sum: { lineTotalMinor: true, taxMinor: true },
        orderBy: { taxRateBp: 'asc' },
      });
      const rows = grouped.map((g) => ({
        taxRateBp: g.taxRateBp,
        taxableMinor: g._sum?.lineTotalMinor ?? 0,
        taxMinor: g._sum?.taxMinor ?? 0,
      }));
      return {
        from,
        to,
        rows,
        totalTaxableMinor: rows.reduce((s, r) => s + r.taxableMinor, 0),
        totalTaxMinor: rows.reduce((s, r) => s + r.taxMinor, 0),
      };
    });
  }

  /** Every item sold in the window, by the name it was sold under. */
  async itemSales(fromStr: string, toStr: string) {
    const { from, to } = this.window(fromStr, toStr);
    return this.prisma.tx(async (db) => {
      const grouped = await db.orderItem.groupBy({
        by: ['nameSnapshot'],
        where: {
          order: { status: COUNTABLE, createdAt: { gte: from, lte: to } },
        },
        _sum: { quantity: true, lineTotalMinor: true },
        orderBy: { _sum: { lineTotalMinor: 'desc' } },
      });
      const rows = grouped.map((g) => ({
        name: g.nameSnapshot,
        quantity: g._sum?.quantity ?? 0,
        revenueMinor: g._sum?.lineTotalMinor ?? 0,
      }));
      return { from, to, rows };
    });
  }

  /**
   * Revenue by category. order_items snapshot the name but not the category,
   * so this joins each line back to its product's CURRENT category. Lines whose
   * product was deleted, or which never had a category, fall into
   * "Uncategorised". Raw SQL because the join is beyond groupBy — parameterised,
   * and RLS applies since it runs inside the tenant transaction.
   */
  async categorySales(fromStr: string, toStr: string) {
    const { from, to } = this.window(fromStr, toStr);
    return this.prisma.tx(async (db) => {
      const rows = await db.$queryRaw<
        Array<{ category: string; quantity: bigint; revenue: bigint }>
      >`
        SELECT COALESCE(c.name, 'Uncategorised') AS category,
               SUM(oi.quantity)::bigint AS quantity,
               SUM(oi.line_total_minor)::bigint AS revenue
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        LEFT JOIN products p ON p.id = oi.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE o.status NOT IN ('VOIDED', 'CANCELLED')
          AND o.created_at >= ${from} AND o.created_at <= ${to}
        GROUP BY category
        ORDER BY revenue DESC
      `;
      return {
        from,
        to,
        rows: rows.map((r) => ({
          category: r.category,
          quantity: Number(r.quantity),
          revenueMinor: Number(r.revenue),
        })),
      };
    });
  }

  /**
   * Payment settlement: money in by method, less refunds by method, for
   * end-of-period reconciliation against the bank / UPI statements.
   */
  async settlement(fromStr: string, toStr: string) {
    const { from, to } = this.window(fromStr, toStr);
    return this.prisma.tx(async (db) => {
      const [pays, refunds] = await Promise.all([
        db.payment.groupBy({
          by: ['method'],
          where: { status: 'CAPTURED', createdAt: { gte: from, lte: to } },
          _sum: { amountMinor: true },
          _count: { _all: true },
        }),
        db.refund.groupBy({
          by: ['method'],
          where: { createdAt: { gte: from, lte: to } },
          _sum: { amountMinor: true },
          _count: { _all: true },
        }),
      ]);
      const refundByMethod = new Map(
        refunds.map((r) => [r.method, r._sum?.amountMinor ?? 0]),
      );
      const rows = pays
        .map((p) => {
          const captured = p._sum?.amountMinor ?? 0;
          const refunded = refundByMethod.get(p.method) ?? 0;
          return {
            method: p.method,
            capturedMinor: captured,
            refundedMinor: refunded,
            netMinor: captured - refunded,
            count: p._count?._all ?? 0,
          };
        })
        .sort((a, b) => b.netMinor - a.netMinor);
      return {
        from,
        to,
        rows,
        totalCapturedMinor: rows.reduce((s, r) => s + r.capturedMinor, 0),
        totalRefundedMinor: rows.reduce((s, r) => s + r.refundedMinor, 0),
        totalNetMinor: rows.reduce((s, r) => s + r.netMinor, 0),
      };
    });
  }

  /**
   * Voided and cancelled orders with the actor and the typed reason — the
   * owner's anti-theft view. Reads the append-only order_events trail.
   */
  async voids(fromStr: string, toStr: string) {
    const { from, to } = this.window(fromStr, toStr);
    return this.prisma.tx(async (db) => {
      const orders = await db.order.findMany({
        where: {
          status: { in: [OrderStatus.VOIDED, OrderStatus.CANCELLED] },
          createdAt: { gte: from, lte: to },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          totalMinor: true,
          createdAt: true,
          events: {
            where: {
              type: 'STATUS_CHANGED',
              toStatus: { in: [OrderStatus.VOIDED, OrderStatus.CANCELLED] },
            },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { actorUserId: true, metadata: true, createdAt: true },
          },
        },
      });
      const rows = orders.map((o) => {
        const ev = o.events[0];
        const reason =
          ev &&
          typeof (ev.metadata as { reason?: unknown })?.reason === 'string'
            ? (ev.metadata as { reason: string }).reason
            : null;
        return {
          id: o.id,
          orderNumber: o.orderNumber,
          status: o.status,
          totalMinor: o.totalMinor,
          reason,
          actorUserId: ev?.actorUserId ?? null,
          at: ev?.createdAt ?? o.createdAt,
        };
      });
      return {
        from,
        to,
        rows,
        count: rows.length,
        totalMinor: rows.reduce((s, r) => s + r.totalMinor, 0),
      };
    });
  }

  /**
   * Discounted orders in the window, with the coupon code when one was used.
   * Discounts move money off a sale, so they get the same scrutiny as voids.
   */
  async discounts(fromStr: string, toStr: string) {
    const { from, to } = this.window(fromStr, toStr);
    return this.prisma.tx(async (db) => {
      const orders = await db.order.findMany({
        where: {
          discountMinor: { gt: 0 },
          status: COUNTABLE,
          createdAt: { gte: from, lte: to },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderNumber: true,
          subtotalMinor: true,
          discountMinor: true,
          totalMinor: true,
          createdAt: true,
        },
      });
      const codeByOrder = await this.couponCodes(
        db,
        orders.map((o) => o.id),
      );
      const rows = orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        subtotalMinor: o.subtotalMinor,
        discountMinor: o.discountMinor,
        totalMinor: o.totalMinor,
        couponCode: codeByOrder.get(o.id) ?? null,
        at: o.createdAt,
      }));
      return {
        from,
        to,
        rows,
        count: rows.length,
        totalDiscountMinor: rows.reduce((s, r) => s + r.discountMinor, 0),
      };
    });
  }

  /** orderId -> coupon code, for the orders that redeemed one. */
  private async couponCodes(db: TxClient, orderIds: string[]) {
    if (!orderIds.length) return new Map<string, string>();
    const redemptions = await db.couponRedemption.findMany({
      where: { orderId: { in: orderIds } },
      select: { orderId: true, coupon: { select: { code: true } } },
    });
    return new Map(redemptions.map((r) => [r.orderId, r.coupon.code]));
  }

  /**
   * The tenant audit log — voids, refunds, restaurant edits. Keyset-paginated
   * by id (UUIDv7 is time-ordered). audit.read only.
   */
  async auditLog(opts: { limit?: number; cursor?: string; action?: string }) {
    const take = Math.min(opts.limit ?? 50, 100);
    return this.prisma.tx((db) =>
      db.auditLog.findMany({
        take,
        where: {
          ...(opts.action ? { action: opts.action } : {}),
          ...(opts.cursor ? { id: { lt: opts.cursor } } : {}),
        },
        orderBy: { id: 'desc' },
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          userId: true,
          metadata: true,
          createdAt: true,
        },
      }),
    );
  }

  /** Parse + validate an IST calendar-day window, inclusive of both ends. */
  private window(fromStr: string, toStr: string): { from: Date; to: Date } {
    const from = new Date(`${fromStr}T00:00:00.000${IST_OFFSET}`);
    const to = new Date(`${toStr}T23:59:59.999${IST_OFFSET}`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from and to must be real calendar dates');
    }
    if (from > to) {
      throw new BadRequestException('from must not be after to');
    }
    return { from, to };
  }
}
