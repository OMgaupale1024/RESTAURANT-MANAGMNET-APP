import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService, type TxClient } from '../../prisma/prisma.service';
import { OrderStatus } from '../../generated/prisma/enums';
import type { CreateCouponDto, UpdateCouponDto } from './dto/coupon.dto';
import {
  SEGMENT_KEYS,
  SEGMENT_META,
  SEGMENT_THRESHOLDS,
  classifySegment,
  type SegmentKey,
} from './segment';

export type CouponValidation =
  | { ok: true; couponId: string; discountMinor: number }
  | { ok: false; reason: string };

@Injectable()
export class MarketingService {
  constructor(private readonly prisma: PrismaService) {}

  // --- Coupons --------------------------------------------------------------

  async createCoupon(dto: CreateCouponDto) {
    const ctx = this.prisma.requireContext();

    // Belt-and-braces on top of the DB CHECK: reject a value shape that does
    // not match the type before it ever reaches the database.
    if (dto.type === 'PERCENT' && !dto.percentBp) {
      throw new BadRequestException('PERCENT coupon needs percentBp');
    }
    if (dto.type === 'FIXED' && !dto.amountMinor) {
      throw new BadRequestException('FIXED coupon needs amountMinor');
    }

    try {
      return await this.prisma.tx((db) =>
        db.coupon.create({
          data: {
            restaurantId: ctx.restaurantId,
            code: dto.code,
            type: dto.type,
            percentBp: dto.type === 'PERCENT' ? dto.percentBp : null,
            amountMinor: dto.type === 'FIXED' ? dto.amountMinor : null,
            maxDiscountMinor:
              dto.type === 'PERCENT' ? (dto.maxDiscountMinor ?? null) : null,
            minSubtotalMinor: dto.minSubtotalMinor ?? 0,
            maxRedemptions: dto.maxRedemptions ?? null,
            validFrom: dto.validFrom ? new Date(dto.validFrom) : null,
            validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
          },
          select: couponSelect,
        }),
      );
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException('A coupon with that code already exists');
      }
      throw e;
    }
  }

  async listCoupons() {
    return this.prisma.tx((db) =>
      db.coupon.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          ...couponSelect,
          _count: { select: { redemptions: true } },
        },
      }),
    );
  }

  async setCouponActive(id: string, dto: UpdateCouponDto) {
    return this.prisma.tx(async (db) => {
      const coupon = await db.coupon.findFirst({
        where: { id },
        select: { id: true },
      });
      if (!coupon) throw new NotFoundException('Coupon not found');
      return db.coupon.update({
        where: { id },
        data: { isActive: dto.isActive },
        select: couponSelect,
      });
    });
  }

  /**
   * Validates a coupon against an order's subtotal and computes the discount —
   * deterministically, server-side.
   *
   * Runs INSIDE the order transaction (the caller passes its db handle) so the
   * redemption count is consistent with the order being created. The discount
   * is recomputed here from the coupon rules; the client's only input was the
   * code, so it can never dictate the amount.
   */
  async validateAndComputeDiscount(
    db: TxClient,
    code: string,
    subtotalMinor: number,
  ): Promise<CouponValidation> {
    const coupon = await db.coupon.findFirst({
      where: { code: code.trim().toUpperCase() },
    });

    // Every failure returns a plain reason; a redeemed/expired/unknown code are
    // all just "not usable" to the caller.
    if (!coupon || !coupon.isActive) {
      return { ok: false, reason: 'Coupon is not valid' };
    }

    const now = new Date();
    if (coupon.validFrom && coupon.validFrom > now) {
      return { ok: false, reason: 'Coupon is not active yet' };
    }
    if (coupon.validUntil && coupon.validUntil < now) {
      return { ok: false, reason: 'Coupon has expired' };
    }
    if (subtotalMinor < coupon.minSubtotalMinor) {
      return {
        ok: false,
        reason: `Order must be at least ${coupon.minSubtotalMinor / 100} to use this coupon`,
      };
    }
    if (coupon.maxRedemptions !== null) {
      const used = await db.couponRedemption.count({
        where: { couponId: coupon.id },
      });
      if (used >= coupon.maxRedemptions) {
        return { ok: false, reason: 'Coupon has been fully redeemed' };
      }
    }

    // Compute the discount. PERCENT is off the subtotal (optionally capped);
    // FIXED is a flat amount. Either way it can never exceed the subtotal — the
    // orders CHECK (discount <= subtotal) is the last line of defence.
    let discount =
      coupon.type === 'PERCENT'
        ? Math.floor((subtotalMinor * (coupon.percentBp ?? 0)) / 10_000)
        : (coupon.amountMinor ?? 0);

    if (coupon.maxDiscountMinor !== null) {
      discount = Math.min(discount, coupon.maxDiscountMinor);
    }
    discount = Math.min(discount, subtotalMinor);

    if (discount <= 0) {
      return { ok: false, reason: 'Coupon gives no discount on this order' };
    }
    return { ok: true, couponId: coupon.id, discountMinor: discount };
  }

  /** Records a redemption. Append-only; called inside the order transaction. */
  async recordRedemption(
    db: TxClient,
    restaurantId: string,
    couponId: string,
    orderId: string,
    discountMinor: number,
  ) {
    await db.couponRedemption.create({
      data: { restaurantId, couponId, orderId, discountMinor },
    });
  }

  // --- Segments (deterministic) --------------------------------------------

  /**
   * Classifies purchasing customers into exactly one segment by a documented
   * rule set. Reuses order history (the same non-void exclusion as everywhere).
   *
   * A recommendation is attached — advisory only, clearly labelled with its
   * method and the count it is based on. It suggests; it never acts, and it is
   * never the authority for any money decision.
   */
  async segments() {
    return this.prisma.tx(async (db) => {
      // Per-customer purchasing stats, non-void only.
      const grouped = await db.order.groupBy({
        by: ['customerId'],
        where: {
          customerId: { not: null },
          status: { notIn: [OrderStatus.VOIDED, OrderStatus.CANCELLED] },
        },
        _count: { _all: true },
        _sum: { totalMinor: true },
        _max: { createdAt: true },
      });

      const now = new Date();
      const counts: Record<SegmentKey, number> = {
        VIP: 0,
        REGULAR: 0,
        NEW: 0,
        LAPSED: 0,
      };
      for (const g of grouped) {
        counts[this.classifyGroup(g, now)]++;
      }

      const segments = SEGMENT_KEYS.map((key) => ({
        key,
        label: SEGMENT_META[key].label,
        rule: SEGMENT_META[key].rule,
        count: counts[key],
      }));

      const recommendations: Array<{
        method: 'DETERMINISTIC';
        title: string;
        detail: string;
        basis: string;
      }> = [];
      if (counts.LAPSED > 0) {
        recommendations.push({
          method: 'DETERMINISTIC' as const,
          title: `${counts.LAPSED} lapsed customer(s) could be won back`,
          detail:
            'These customers used to visit but have not in a while. A win-back coupon may bring them back.',
          basis: `${counts.LAPSED} customers with no non-void order in the last ${SEGMENT_THRESHOLDS.LAPSED_AFTER_DAYS} days`,
        });
      }

      return { segments, recommendations };
    });
  }

  /** The customers in one segment, so an owner can act on them. */
  async segmentCustomers(key: string) {
    if (!SEGMENT_KEYS.includes(key as SegmentKey)) {
      throw new BadRequestException('Unknown segment');
    }

    return this.prisma.tx(async (db) => {
      const grouped = await db.order.groupBy({
        by: ['customerId'],
        where: {
          customerId: { not: null },
          status: { notIn: [OrderStatus.VOIDED, OrderStatus.CANCELLED] },
        },
        _count: { _all: true },
        _sum: { totalMinor: true },
        _max: { createdAt: true },
      });

      const now = new Date();
      const ids = grouped
        .filter((g) => this.classifyGroup(g, now) === key)
        .map((g) => g.customerId!)
        .filter(Boolean);

      if (ids.length === 0) return [];

      const customers = await db.customer.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, phone: true, email: true },
        orderBy: { name: 'asc' },
      });
      return customers;
    });
  }

  /** Adapts a Prisma order groupBy row to the shared classifier. */
  private classifyGroup(
    g: {
      _count: { _all: number };
      _sum: { totalMinor: number | null };
      _max: { createdAt: Date | null };
    },
    now: Date,
  ): SegmentKey {
    return classifySegment(
      {
        visits: g._count._all,
        spentMinor: g._sum.totalMinor ?? 0,
        lastVisit: g._max.createdAt,
      },
      now,
    );
  }
}

const couponSelect = {
  id: true,
  code: true,
  type: true,
  percentBp: true,
  amountMinor: true,
  maxDiscountMinor: true,
  minSubtotalMinor: true,
  maxRedemptions: true,
  validFrom: true,
  validUntil: true,
  isActive: true,
  createdAt: true,
} as const;
