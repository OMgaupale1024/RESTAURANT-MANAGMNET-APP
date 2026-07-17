import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateRestaurantDto } from './dto/create-restaurant.dto';

@Injectable()
export class RestaurantsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a restaurant, its first branch, and an OWNER membership for the
   * creating user — atomically.
   *
   * The chicken-and-egg: RLS requires `app.restaurant_id` to insert a
   * tenant-scoped row, but the tenant does not exist yet. Resolved by
   * generating the id client-side (UUIDv7) and opening the transaction with
   * that id already in context. The tenant therefore exists, from the
   * database's point of view, before its first row is written.
   *
   * Atomicity matters more than it looks: a restaurant without an OWNER
   * membership would be permanently unreachable — nobody could ever get a
   * token scoped to it. Partial success here is worse than failure.
   */
  async create(userId: string, dto: CreateRestaurantDto) {
    const ownerRole = await this.prisma.role.findUnique({
      where: { key: 'OWNER' },
      select: { id: true },
    });
    if (!ownerRole) {
      // Seed has not run. A real misconfiguration, not user error.
      throw new InternalServerErrorException('OWNER role is not seeded');
    }

    const base = slugify(dto.name);

    // Insert-and-retry rather than check-then-insert.
    //
    // The app role CANNOT check slug uniqueness with a SELECT: slugs are
    // globally unique, but RLS hides other tenants' restaurants, so the check
    // would always report "free" and the insert would then blow up on the
    // unique index. (It did — caught by the colliding-names test.)
    //
    // So the unique index is the authority and we react to it. This also
    // removes the check-then-insert race that existed regardless of RLS.
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomUUID().slice(0, 6)}`;
      try {
        return await this.insert(userId, dto, slug, ownerRole.id);
      } catch (e) {
        if (isUniqueViolation(e, 'slug')) continue; // name taken, try a suffix
        throw e;
      }
    }
    throw new ConflictException('Could not generate a unique slug');
  }

  private async insert(
    userId: string,
    dto: CreateRestaurantDto,
    slug: string,
    ownerRoleId: string,
  ) {
    // Generated client-side so the tenant context can be set before the tenant
    // exists — RLS requires app.restaurant_id to insert the restaurant row
    // itself. UUIDv4 here is fine; v7's index locality matters for high-volume
    // tables, not for one row per business.
    const restaurantId = randomUUID();

    return this.prisma.txAs({ userId, restaurantId }, async (db) => {
      const restaurant = await db.restaurant.create({
        data: { id: restaurantId, name: dto.name, slug },
        select: { id: true, name: true, slug: true, createdAt: true },
      });

      const branch = await db.branch.create({
        data: {
          restaurantId,
          name: dto.branchName?.length ? dto.branchName : 'Main',
          address: dto.branchAddress || null,
        },
        select: { id: true, name: true, address: true },
      });

      const membership = await db.membership.create({
        data: { userId, restaurantId, roleId: ownerRoleId },
        select: { id: true },
      });

      // First entry in this tenant's audit trail. Append-only by trigger.
      await db.auditLog.create({
        data: {
          restaurantId,
          userId,
          action: 'restaurant.created',
          entityType: 'restaurant',
          entityId: restaurantId,
          metadata: { name: dto.name, slug, branchId: branch.id },
        },
      });

      return { restaurant, branch, membershipId: membership.id };
    });
  }

  /** Restaurants the user belongs to. RLS scopes memberships to their own. */
  async listForUser(userId: string) {
    return this.prisma.txAs({ userId, restaurantId: null }, (db) =>
      db.membership.findMany({
        where: { userId, isActive: true },
        select: {
          id: true,
          restaurant: { select: { id: true, name: true, slug: true } },
          role: { select: { key: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }
}

/** Slugs are globally unique — they may become public URLs. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'restaurant'
  );
}

/**
 * Prisma's unique-constraint error, narrowed to a specific field.
 *
 * Two shapes, because Prisma 7 changed this: with driver adapters there is no
 * `meta.target` any more — the constraint name only appears inside
 * `meta.driverAdapterError.cause.originalMessage`. Both are checked so this
 * keeps working if that ever moves back.
 */
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
  if (target !== undefined) {
    const targets = Array.isArray(target) ? target : [target];
    if (targets.some((t) => typeof t === 'string' && t.includes(field))) {
      return true;
    }
  }

  const driverMessage = err.meta?.driverAdapterError?.cause?.originalMessage;
  return typeof driverMessage === 'string' && driverMessage.includes(field);
}
