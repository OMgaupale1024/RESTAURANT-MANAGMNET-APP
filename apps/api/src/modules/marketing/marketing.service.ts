import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService, type TxClient } from '../../prisma/prisma.service';
import { OrderStatus } from '../../generated/prisma/enums';
import type { CreateCouponDto, UpdateCouponDto } from './dto/coupon.dto';

/**
 * Deterministic segmentation thresholds. Constants, not settings — a
 * per-restaurant tuning UI would be a settings concern that does not exist yet.
 * Every rule is stated back to the caller so a segment is never a black box.
 */
const VIP_MIN_VISITS = 5;
const VIP_MIN_SPENT_MINOR = 500_000; // ₹5,000
const REGULAR_MIN_VISITS = 3;
const LAPSED_AFTER_DAYS = 30;

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

      const lapsedCutoff = new Date(
        Date.now() - LAPSED_AFTER_DAYS * 86_400_000,
      );
      const counts: Record<string, number> = {
        VIP: 0,
        REGULAR: 0,
        NEW: 0,
        LAPSED: 0,
      };

      for (const g of grouped) {
        counts[this.classify(g, lapsedCutoff)]++;
      }

      const segments = [
        {
          key: 'VIP',
          label: 'VIP',
          rule: `${VIP_MIN_VISITS}+ visits and ${VIP_MIN_SPENT_MINOR / 100}+ spent`,
          count: counts.VIP,
        },
        {
          key: 'REGULAR',
          label: 'Regular',
          rule: `${REGULAR_MIN_VISITS}+ visits`,
          count: counts.REGULAR,
        },
        {
          key: 'NEW',
          label: 'New',
          rule: 'Fewer visits, seen recently',
          count: counts.NEW,
        },
        {
          key: 'LAPSED',
          label: 'Lapsed',
          rule: `No visit in ${LAPSED_AFTER_DAYS} days`,
          count: counts.LAPSED,
        },
      ];

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
          basis: `${counts.LAPSED} customers with no non-void order in the last ${LAPSED_AFTER_DAYS} days`,
        });
      }

      return { segments, recommendations };
    });
  }

  /** The customers in one segment, so an owner can act on them. */
  async segmentCustomers(key: string) {
    const valid = ['VIP', 'REGULAR', 'NEW', 'LAPSED'];
    if (!valid.includes(key)) throw new BadRequestException('Unknown segment');

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

      const lapsedCutoff = new Date(
        Date.now() - LAPSED_AFTER_DAYS * 86_400_000,
      );
      const ids = grouped
        .filter((g) => this.classify(g, lapsedCutoff) === key)
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

  private classify(
    g: {
      _count: { _all: number };
      _sum: { totalMinor: number | null };
      _max: { createdAt: Date | null };
    },
    lapsedCutoff: Date,
  ): 'VIP' | 'REGULAR' | 'NEW' | 'LAPSED' {
    const visits = g._count._all;
    const spent = g._sum.totalMinor ?? 0;
    const last = g._max.createdAt;

    // Recency first: a lapsed VIP is a win-back target, not a VIP to reward.
    if (last && last < lapsedCutoff) return 'LAPSED';
    if (visits >= VIP_MIN_VISITS && spent >= VIP_MIN_SPENT_MINOR) return 'VIP';
    if (visits >= REGULAR_MIN_VISITS) return 'REGULAR';
    return 'NEW';
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
