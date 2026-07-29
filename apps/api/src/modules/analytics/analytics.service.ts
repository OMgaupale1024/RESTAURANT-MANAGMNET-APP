import { BadRequestException, Injectable } from '@nestjs/common';
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

      // Serial, not Promise.all: every query in one interactive transaction
      // shares a single pg connection, and concurrent queries on one connection
      // are unsafe under @prisma/adapter-pg (pg removes it in v9). Awaiting each
      // array element runs them one at a time.
      const [summary, itemsAgg, series, topProducts, payments, hours] = [
        await db.order.aggregate({
          where,
          _count: { _all: true },
          _sum: { totalMinor: true },
          _avg: { totalMinor: true },
        }),
        await db.orderItem.aggregate({
          where: { order: where },
          _sum: { quantity: true },
        }),
        await this.revenueSeries(db, from, to),
        await this.topProducts(db, from, to),
        await this.paymentBreakdown(db, from, to),
        await this.peakHours(db, from, to),
      ];

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
   * The owner's business-insights beyond core sales: refunds, cancellations,
   * customers (new / active / returning), loyalty (members, points in & out),
   * and kitchen throughput. Every figure is aggregated in Postgres inside one
   * tenant-scoped transaction — RLS applies to the raw-SQL blocks exactly as it
   * does to `revenueSeries`, so no restaurant_id filter is written here.
   *
   * This is ADDITIVE: `overviewBetween` (shared with Reports) is untouched.
   * Nothing is materialised or cached — the tables carry a
   * `(restaurant_id, created_at)` index for every window scan below.
   */
  async insights(q: { range?: Range; from?: string; to?: string }) {
    const { from, to } = this.resolveWindow(q);
    return this.prisma.tx(async (db) => {
      // Serial, not Promise.all — one tx, one pg connection (adapter-pg rule).
      const [money, customers, loyalty, kitchen] = [
        await this.moneyStats(db, from, to),
        await this.customerStats(db, from, to),
        await this.loyaltyStats(db, from, to),
        await this.kitchenStats(db, from, to),
      ];
      return { from, to, ...money, customers, loyalty, kitchen };
    });
  }

  /**
   * Refunds, the refund rate, and cancellations for the window. The refund rate
   * is refunded ÷ gross countable revenue, in basis points (an integer — a
   * fractional-percent float is a rounding argument waiting to happen). Refunds
   * are windowed by when the money went back, gross by when the sale landed.
   */
  private async moneyStats(db: TxClient, from: Date, to: Date) {
    const window = { gte: from, lte: to };
    const gross = await db.order.aggregate({
      where: { status: COUNTABLE, createdAt: window },
      _sum: { totalMinor: true },
    });
    const ref = await db.refund.aggregate({
      where: { createdAt: window },
      _sum: { amountMinor: true },
      _count: { _all: true },
    });
    const cancelled = await db.order.count({
      where: {
        status: { in: [OrderStatus.VOIDED, OrderStatus.CANCELLED] },
        createdAt: window,
      },
    });
    const grossMinor = gross._sum?.totalMinor ?? 0;
    const refundedMinor = ref._sum?.amountMinor ?? 0;
    return {
      refunds: {
        amountMinor: refundedMinor,
        count: ref._count?._all ?? 0,
        rateBp:
          grossMinor > 0 ? Math.round((refundedMinor / grossMinor) * 10000) : 0,
      },
      cancelledOrders: cancelled,
    };
  }

  /**
   * New / active / returning customers. `new` = accounts created in the window;
   * `active` = distinct customers who placed a countable order in it;
   * `returning` = those active customers who had also ordered BEFORE it. A true
   * cohort-retention rate is deliberately omitted — it needs a fixed cohort
   * definition this milestone does not set (see docs/architecture/analytics.md).
   */
  private async customerStats(db: TxClient, from: Date, to: Date) {
    const rows = await db.$queryRaw<
      Array<{ new_count: bigint; active: bigint; returning: bigint }>
    >`
      SELECT
        (SELECT COUNT(*) FROM customers
           WHERE created_at >= ${from} AND created_at <= ${to})::bigint AS new_count,
        (SELECT COUNT(DISTINCT o.customer_id) FROM orders o
           WHERE o.customer_id IS NOT NULL
             AND o.status NOT IN ('VOIDED', 'CANCELLED')
             AND o.created_at >= ${from} AND o.created_at <= ${to})::bigint AS active,
        (SELECT COUNT(*) FROM (
           SELECT o.customer_id FROM orders o
           WHERE o.customer_id IS NOT NULL
             AND o.status NOT IN ('VOIDED', 'CANCELLED')
             AND o.created_at >= ${from} AND o.created_at <= ${to}
           GROUP BY o.customer_id
           HAVING EXISTS (
             SELECT 1 FROM orders p
             WHERE p.customer_id = o.customer_id
               AND p.status NOT IN ('VOIDED', 'CANCELLED')
               AND p.created_at < ${from}
           )
         ) r)::bigint AS returning
    `;
    const r = rows[0];
    return {
      new: Number(r.new_count),
      active: Number(r.active),
      returning: Number(r.returning),
    };
  }

  /**
   * Loyalty programme size and points flow. `members` is the lifetime count of
   * customers with any ledger row (a member is a member regardless of window);
   * `pointsIssued` sums every credit in the window; `pointsRedeemed` is what
   * customers actually spent (REDEEM only — a negative ADJUST or an EXPIRE is a
   * correction/lapse, not a redemption). Signs follow the ledger's CHECK.
   */
  private async loyaltyStats(db: TxClient, from: Date, to: Date) {
    const rows = await db.$queryRaw<
      Array<{ members: bigint; issued: bigint; redeemed: bigint }>
    >`
      SELECT
        (SELECT COUNT(DISTINCT customer_id) FROM loyalty_ledger)::bigint AS members,
        COALESCE(SUM(points) FILTER (
          WHERE points > 0 AND created_at >= ${from} AND created_at <= ${to}
        ), 0)::bigint AS issued,
        COALESCE(-SUM(points) FILTER (
          WHERE type = 'REDEEM' AND created_at >= ${from} AND created_at <= ${to}
        ), 0)::bigint AS redeemed
      FROM loyalty_ledger
    `;
    const r = rows[0];
    return {
      members: Number(r.members),
      pointsIssued: Number(r.issued),
      pointsRedeemed: Number(r.redeemed),
    };
  }

  /**
   * Kitchen throughput. `completed` counts orders that reached COMPLETED in the
   * window. Prep time is measured only for orders that actually went through the
   * kitchen — the span from their PREPARING event to their READY event — so
   * `avgPrepSecs` / `longestPrepSecs` are null (omitted, never faked) when no
   * such order exists, and `prepSamples` is the honest denominator behind them.
   * MIN() per order guards against any duplicate transition rows.
   */
  private async kitchenStats(db: TxClient, from: Date, to: Date) {
    const rows = await db.$queryRaw<
      Array<{
        completed: bigint;
        samples: bigint;
        avg_secs: number | null;
        max_secs: number | null;
      }>
    >`
      WITH ready AS (
        SELECT order_id, MIN(created_at) AS ready_at FROM order_events
        WHERE to_status = 'READY' AND created_at >= ${from} AND created_at <= ${to}
        GROUP BY order_id
      ),
      prep AS (
        SELECT order_id, MIN(created_at) AS prep_at FROM order_events
        WHERE to_status = 'PREPARING'
        GROUP BY order_id
      ),
      spans AS (
        SELECT EXTRACT(EPOCH FROM (r.ready_at - p.prep_at)) AS secs
        FROM ready r JOIN prep p ON p.order_id = r.order_id
        WHERE r.ready_at >= p.prep_at
      )
      SELECT
        (SELECT COUNT(*) FROM order_events
           WHERE to_status = 'COMPLETED'
             AND created_at >= ${from} AND created_at <= ${to})::bigint AS completed,
        (SELECT COUNT(*) FROM spans)::bigint AS samples,
        (SELECT AVG(secs) FROM spans)::float AS avg_secs,
        (SELECT MAX(secs) FROM spans)::float AS max_secs
    `;
    const r = rows[0];
    return {
      completed: Number(r.completed),
      prepSamples: Number(r.samples),
      avgPrepSecs: r.avg_secs != null ? Math.round(r.avg_secs) : null,
      longestPrepSecs: r.max_secs != null ? Math.round(r.max_secs) : null,
    };
  }

  /** Presets resolve to IST bounds; an explicit from/to (Yesterday, Custom) is
   *  parsed as inclusive IST days — the same contract Reports uses. */
  private resolveWindow(q: { range?: Range; from?: string; to?: string }): {
    from: Date;
    to: Date;
  } {
    if (q.from && q.to) {
      // Offset from a KNOWN-valid instant, not the parsed input — IST has no DST
      // so it is date-independent, and this way an impossible date (2026-13-40)
      // falls through to the NaN guard below instead of throwing inside tzOffset.
      const off = tzOffset(new Date());
      const from = new Date(`${q.from}T00:00:00.000${off}`);
      const to = new Date(`${q.to}T23:59:59.999${off}`);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new BadRequestException(
          'from and to must be real calendar dates',
        );
      }
      if (from > to) throw new BadRequestException('from must not be after to');
      return { from, to };
    }
    return this.bounds(q.range ?? '7d');
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
    if (range === 'today') {
      // NOT setHours(0,0,0,0): that resolves in the Node process's timezone, so
      // on a UTC host (every target in DEPLOYMENT.md) "today" began at 05:30
      // IST and silently dropped the small hours of trade. The day buckets in
      // revenueSeries/peakHours have always been IST; this bound now agrees.
      return { from: istStartOfDay(to), to };
    }
    const from = new Date(to);
    const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
    from.setDate(from.getDate() - days);
    return { from, to };
  }
}

/**
 * TZ's UTC offset at a given instant, as an ISO suffix ("+05:30").
 *
 * Derived from TZ, never written down: a second hardcoded representation of
 * the same fact is one that can silently disagree with TZ later. Asking Intl
 * for the offset at `at` also means a zone with DST reports the offset that
 * was actually in force, rather than a fixed guess.
 */
function tzOffset(at: Date): string {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    timeZoneName: 'longOffset',
  })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')!.value;
  // "GMT+05:30" -> "+05:30". A zero-offset zone formats as bare "GMT".
  return name.replace('GMT', '') || '+00:00';
}

/**
 * The instant midnight began, in TZ, for the day containing `at`.
 * Exported for the regression test that pins this to TZ rather than the host.
 */
export function istStartOfDay(at: Date): Date {
  // en-CA formats as YYYY-MM-DD, which is exactly the anchor format below.
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  return new Date(`${day}T00:00:00.000${tzOffset(at)}`);
}
