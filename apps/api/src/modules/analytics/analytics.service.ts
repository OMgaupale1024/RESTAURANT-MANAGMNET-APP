import { Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../prisma/prisma.service';
import { OrderStatus } from '../../generated/prisma/enums';
import type { Prisma } from '../../generated/prisma/client';

type Range = 'today' | '7d' | '30d' | '90d';

/**
 * The window is IST. OraOS is India-first (GST, paise, UPI, phone rules), so a
 * "day" is an IST wall-clock day — bucketing by UTC would split a restaurant's
 * evening service across two dates. Per-restaurant timezone is a settings
 * concern that does not exist yet (see BACKLOG).
 */
const TZ = 'Asia/Kolkata';

/** A reversed sale did not happen — the same rule as customer stats (Step 12). */
const COUNTABLE: Prisma.OrderWhereInput['status'] = {
  notIn: [OrderStatus.VOIDED, OrderStatus.CANCELLED],
};

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Everything the dashboard needs, in one tenant-scoped transaction.
   *
   * Every figure is aggregated in Postgres. Raw order rows never leave the
   * database — the client receives sums, not a spreadsheet it might re-total
   * differently (or wrongly). RLS scopes all of it; there is deliberately no
   * `restaurant_id` filter in any query here.
   */
  async overview(range: Range) {
    const { from, to } = this.bounds(range);
    return { range, ...(await this.overviewBetween(from, to)) };
  }

  /**
   * The overview for an explicit window. This is the single source of the sales
   * figures — Reports (Step 19) calls it with a custom date range rather than
   * recomputing anything, so an exported total is the same number the dashboard
   * shows, by construction.
   */
  async overviewBetween(from: Date, to: Date) {
    return this.prisma.tx(async (db) => {
      const where: Prisma.OrderWhereInput = {
        status: COUNTABLE,
        createdAt: { gte: from, lte: to },
      };

      const [summary, itemsAgg, series, topProducts, payments, hours] =
        await Promise.all([
          db.order.aggregate({
            where,
            _count: { _all: true },
            _sum: { totalMinor: true },
            _avg: { totalMinor: true },
          }),
          db.orderItem.aggregate({
            where: { order: where },
            _sum: { quantity: true },
          }),
          this.revenueSeries(db, from, to),
          this.topProducts(db, from, to),
          this.paymentBreakdown(db, from, to),
          this.peakHours(db, from, to),
        ]);

      return {
        from,
        to,
        summary: {
          revenueMinor: summary._sum?.totalMinor ?? 0,
          orders: summary._count?._all ?? 0,
          // Rounded to whole paise — a fractional average paisa is not money.
          averageBillMinor: summary._avg?.totalMinor
            ? Math.round(summary._avg.totalMinor)
            : 0,
          itemsSold: itemsAgg._sum?.quantity ?? 0,
        },
        revenueSeries: series,
        topProducts,
        paymentBreakdown: payments,
        peakHours: hours,
      };
    });
  }

  /**
   * Daily revenue and order count, bucketed by IST day.
   *
   * Raw SQL because groupBy cannot express date_trunc. Parameterised — the two
   * inputs are Date bounds, never interpolated strings. RLS still applies
   * because this runs inside the tenant transaction.
   *
   * created_at is a timestamp storing UTC; `AT TIME ZONE 'UTC' AT TIME ZONE tz`
   * reinterprets it as an IST wall-clock time before truncating to the day.
   */
  private async revenueSeries(db: TxClient, from: Date, to: Date) {
    const rows = await db.$queryRaw<
      Array<{ day: Date; revenue: bigint; orders: bigint }>
    >`
      SELECT date_trunc('day', created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ}) AS day,
             COALESCE(SUM(total_minor), 0)::bigint AS revenue,
             COUNT(*)::bigint AS orders
      FROM orders
      WHERE status NOT IN ('VOIDED', 'CANCELLED')
        AND created_at >= ${from} AND created_at <= ${to}
      GROUP BY day
      ORDER BY day ASC
    `;
    return rows.map((r) => ({
      date: r.day.toISOString().slice(0, 10),
      revenueMinor: Number(r.revenue),
      orders: Number(r.orders),
    }));
  }

  /**
   * Top items by revenue.
   *
   * Grouped by the SOLD name (nameSnapshot), not the live product: a product
   * renamed mid-period genuinely was two different things to customers, and the
   * snapshot is what the receipt said.
   */
  private async topProducts(db: TxClient, from: Date, to: Date) {
    const grouped = await db.orderItem.groupBy({
      by: ['nameSnapshot'],
      where: {
        order: { status: COUNTABLE, createdAt: { gte: from, lte: to } },
      },
      _sum: { quantity: true, lineTotalMinor: true },
      orderBy: { _sum: { lineTotalMinor: 'desc' } },
      take: 10,
    });
    return grouped.map((g) => ({
      name: g.nameSnapshot,
      quantity: g._sum?.quantity ?? 0,
      revenueMinor: g._sum?.lineTotalMinor ?? 0,
    }));
  }

  /** Captured payments by method. Only CAPTURED counts as taken money. */
  private async paymentBreakdown(db: TxClient, from: Date, to: Date) {
    const grouped = await db.payment.groupBy({
      by: ['method'],
      where: {
        status: 'CAPTURED',
        order: { status: COUNTABLE },
        createdAt: { gte: from, lte: to },
      },
      _sum: { amountMinor: true },
      _count: { _all: true },
    });
    return grouped
      .map((g) => ({
        method: g.method,
        amountMinor: g._sum?.amountMinor ?? 0,
        count: g._count?._all ?? 0,
      }))
      .sort((a, b) => b.amountMinor - a.amountMinor);
  }

  /** Orders by hour of the IST day (0-23), for a peak-hours view. */
  private async peakHours(db: TxClient, from: Date, to: Date) {
    const rows = await db.$queryRaw<Array<{ hour: number; orders: bigint }>>`
      SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})::int AS hour,
             COUNT(*)::bigint AS orders
      FROM orders
      WHERE status NOT IN ('VOIDED', 'CANCELLED')
        AND created_at >= ${from} AND created_at <= ${to}
      GROUP BY hour
      ORDER BY hour ASC
    `;
    // Fill every hour so the chart has a stable 24-slot axis.
    const byHour = new Map(rows.map((r) => [r.hour, Number(r.orders)]));
    return Array.from({ length: 24 }, (_, hour) => ({
      hour,
      orders: byHour.get(hour) ?? 0,
    }));
  }

  private bounds(range: Range): { from: Date; to: Date } {
    const to = new Date();
    const from = new Date(to);
    if (range === 'today') {
      from.setHours(0, 0, 0, 0);
    } else {
      const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
      from.setDate(from.getDate() - days);
    }
    return { from, to };
  }
}
