import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { OrderStatus } from '../../generated/prisma/enums';
import { normalizePhone } from './phone';
import type {
  CreateCustomerDto,
  FindCustomersQuery,
  UpdateCustomerDto,
} from './dto/customer.dto';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Search by name or phone.
   *
   * `q` goes into Prisma's `contains`, which parameterises it — there is no
   * string interpolation into SQL anywhere in this file.
   *
   * Note there is no `where: { restaurantId }`. RLS applies it, and RLS cannot
   * be forgotten. On a PII table that distinction is the whole point.
   */
  list(query: FindCustomersQuery) {
    const take = Math.min(query.limit ?? 50, 100);
    const q = query.q?.trim();

    return this.prisma.tx(async (db) => {
      const customers = await db.customer.findMany({
        take,
        where: q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                // Digits-only, so a search for "98765 43210" still matches.
                { phone: { contains: normalizePhone(q) || q } },
              ],
            }
          : undefined,
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          createdAt: true,
        },
        orderBy: { name: 'asc' },
      });
      if (!customers.length) return [];

      // Per-customer stats for the CRM table, one groupBy for the whole page
      // (same shape as inventory's stockByIngredient). Same countable rule as
      // getById: reversed orders did not happen.
      const grouped = await db.order.groupBy({
        by: ['customerId'],
        where: {
          customerId: { in: customers.map((c) => c.id) },
          status: { notIn: [OrderStatus.VOIDED, OrderStatus.CANCELLED] },
        },
        _count: { _all: true },
        _sum: { totalMinor: true },
        _max: { createdAt: true },
      });
      const byId = new Map(grouped.map((g) => [g.customerId, g]));

      return customers.map((c) => {
        const g = byId.get(c.id);
        const visits = g?._count?._all ?? 0;
        const spent = g?._sum?.totalMinor ?? 0;
        return {
          ...c,
          stats: {
            visits,
            totalSpentMinor: spent,
            averageBillMinor: visits ? Math.round(spent / visits) : 0,
            lastVisit: g?._max?.createdAt ?? null,
          },
        };
      });
    });
  }

  /** Exact phone lookup — what the POS uses at the till. */
  findByPhone(phone: string) {
    // The SAME normaliser as the write path. If these two ever diverge, a
    // customer saved as "+91 ..." becomes unfindable by someone typing the
    // number plainly — which is exactly the bug this replaced.
    const digits = normalizePhone(phone);
    return this.prisma.tx((db) =>
      db.customer.findFirst({
        where: { phone: digits },
        select: { id: true, name: true, phone: true },
      }),
    );
  }

  /**
   * A customer with their derived stats.
   *
   * Stats are aggregated on read rather than cached. The blueprint calls for
   * materialising them and is right at scale — but a cached counter today buys
   * a staleness bug and saves nothing measurable. Postgres aggregates a few
   * thousand rows in milliseconds. See BACKLOG for the trigger to revisit.
   *
   * Voided and cancelled orders are excluded from money and visit counts: an
   * order that was reversed did not happen, and counting it would overstate a
   * customer's value — the exact number an owner would act on.
   */
  async getById(id: string) {
    return this.prisma.tx(async (db) => {
      const customer = await db.customer.findFirst({
        where: { id },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          birthday: true,
          notes: true,
          createdAt: true,
        },
      });
      // Another tenant's customer does not exist here. Same 404 as an unknown
      // id, so this cannot be used to probe.
      if (!customer) throw new NotFoundException('Customer not found');

      // Reversed orders did not happen. Counting a voided sale would overstate
      // a customer's value — the exact number an owner would act on.
      const countable: Prisma.OrderWhereInput = {
        customerId: id,
        status: { notIn: [OrderStatus.VOIDED, OrderStatus.CANCELLED] },
      };

      const [agg, firstOrder, lastOrder, recent] = await Promise.all([
        db.order.aggregate({
          where: countable,
          _count: { _all: true },
          _sum: { totalMinor: true },
          _avg: { totalMinor: true },
        }),
        db.order.findFirst({
          where: countable,
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        db.order.findFirst({
          where: countable,
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
        db.order.findMany({
          where: { customerId: id },
          take: 10,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            orderNumber: true,
            status: true,
            totalMinor: true,
            createdAt: true,
          },
        }),
      ]);

      return {
        ...customer,
        stats: {
          visits: agg._count?._all ?? 0,
          totalSpentMinor: agg._sum?.totalMinor ?? 0,
          // Rounded to whole paise: an average of a third of a rupee is not a
          // real amount, and a float here would leak into a displayed figure.
          averageBillMinor: agg._avg?.totalMinor
            ? Math.round(agg._avg.totalMinor)
            : 0,
          firstVisit: firstOrder?.createdAt ?? null,
          lastVisit: lastOrder?.createdAt ?? null,
        },
        recentOrders: recent,
      };
    });
  }

  async create(dto: CreateCustomerDto) {
    const ctx = this.prisma.requireContext();
    try {
      return await this.prisma.tx((db) =>
        db.customer.create({
          data: {
            restaurantId: ctx.restaurantId,
            name: dto.name,
            phone: dto.phone,
            email: dto.email ?? null,
            birthday: dto.birthday ? new Date(dto.birthday) : null,
            notes: dto.notes ?? null,
          },
          select: { id: true, name: true, phone: true, email: true },
        }),
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        // Safe to say: the conflict is within THIS tenant, which the caller can
        // already see. It reveals nothing about any other restaurant.
        throw new ConflictException(
          'A customer with that phone number already exists',
        );
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdateCustomerDto) {
    return this.prisma.tx(async (db) => {
      const existing = await db.customer.findFirst({
        where: { id },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Customer not found');

      try {
        return await db.customer.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
            ...(dto.email !== undefined ? { email: dto.email } : {}),
            ...(dto.birthday !== undefined
              ? { birthday: dto.birthday ? new Date(dto.birthday) : null }
              : {}),
            ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          },
          select: { id: true, name: true, phone: true, email: true },
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new ConflictException(
            'A customer with that phone number already exists',
          );
        }
        throw e;
      }
    });
  }
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002';
}
