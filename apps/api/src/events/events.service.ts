import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { getTenantContext } from '../common/context/tenant-context';
import type { TxClient } from '../prisma/prisma.service';

/**
 * What happened, as the caller describes it.
 *
 * Note what is deliberately ABSENT: the actor (user) and the tenant
 * (restaurant). Those are never accepted from the caller — they are derived
 * from the request context, the same rule the whole codebase applies to
 * restaurant_id. A caller that could name the tenant could write into another
 * one. See docs/architecture/events.md.
 */
export type EventInput = {
  /** '<entity>.<verb>' — e.g. 'order.voided', 'staff.invited'. */
  action: string;
  /** The kind of thing acted on — e.g. 'order', 'membership', 'restaurant'. */
  entityType: string;
  /** Its id, when there is one. */
  entityId?: string | null;
  /**
   * Structured, non-sensitive detail. NEVER secrets, tokens, card data,
   * passwords, or full PII — this table is read by the audit UI and, later, the
   * timeline. Keep it to ids, amounts, and short labels.
   */
  metadata?: Record<string, unknown>;
};

/**
 * The one place a feature records "something happened in this restaurant".
 *
 * Storage is the existing append-only, RLS-protected `audit_logs` table — this
 * milestone deliberately introduced NO new table (the reasoning is in the
 * doc). What it adds is a single write path, so no feature hand-rolls
 * `db.auditLog.create` and re-derives actor/tenant by hand ever again. Future
 * consumers (Timeline, Customer History, Analytics, Loyalty…) read that same
 * table; future typed wrappers (recordOrder, …) can wrap this method without
 * any caller changing.
 *
 * Transaction-safe by construction: `record` takes the caller's transaction
 * client, so the event commits — or rolls back — atomically with the change
 * that caused it. It is deliberately NOT fire-and-forget; that is
 * SecurityEventService's contract, for the identity/auth path that must not be
 * coupled to a business transaction. Here the opposite is required: there must
 * be no event for a change that never committed.
 *
 * A pure leaf: it injects nothing, which is what keeps it free of any
 * circular-dependency risk and trivially testable.
 */
@Injectable()
export class EventsService {
  /**
   * Records one tenant event, inside the caller's transaction.
   *
   * MUST run within `prisma.tx(...)`: the actor and tenant come from the
   * AsyncLocalStorage request context, and RLS's WITH CHECK verifies
   * restaurant_id against the `app.restaurant_id` that same transaction set. A
   * missing tenant context throws — fail-closed — and because that happens
   * inside the caller's transaction, the whole unit of work rolls back. A
   * tenant event with no tenant is a bug, not a row.
   *
   * The two bootstrap paths whose actor/tenant PREDATE the request context —
   * restaurant creation and invite acceptance — deliberately do not use this;
   * they write the audit row directly. See docs/architecture/events.md.
   */
  async record(db: TxClient, input: EventInput): Promise<void> {
    const ctx = getTenantContext();
    if (!ctx?.restaurantId) {
      // Same guard, same error as PrismaService.requireContext(): a tenant
      // write with no tenant fails loudly rather than writing an orphan row.
      throw new InternalServerErrorException('No restaurant in context');
    }

    await db.auditLog.create({
      data: {
        restaurantId: ctx.restaurantId,
        userId: ctx.userId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        // Cast mirrors SecurityEventService: Prisma's Json input type does not
        // accept an open Record without it. undefined leaves the column NULL.
        metadata: input.metadata as never,
      },
    });
  }
}
