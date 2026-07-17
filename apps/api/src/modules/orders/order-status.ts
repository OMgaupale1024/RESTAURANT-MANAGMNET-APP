import type { OrderStatus } from '../../generated/prisma/enums';

/**
 * The order lifecycle, as a whitelist.
 *
 * A whitelist, not a blacklist: anything not listed is refused. That matters
 * because the interesting attacks are transitions that skip a step —
 * PLACED -> COMPLETED without paying, or CANCELLED -> COMPLETED to resurrect a
 * refunded order.
 *
 * Terminal states are deliberately dead ends. An order that was completed,
 * cancelled or voided is a financial record; correcting it means a new row
 * (refund), never moving it back.
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  DRAFT: ['PLACED', 'CANCELLED'],
  PLACED: ['PREPARING', 'CANCELLED', 'VOIDED'],
  PREPARING: ['READY', 'CANCELLED', 'VOIDED'],
  READY: ['COMPLETED', 'CANCELLED', 'VOIDED'],
  COMPLETED: [], // terminal — refunds are new rows, not a status change
  CANCELLED: [], // terminal
  VOIDED: [], // terminal
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedNext(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from];
}

/**
 * VOID and CANCEL both stop an order, and the distinction is a money one:
 *   CANCELLED — nothing was owed. Called off before it mattered.
 *   VOIDED    — it had been rung up and is being reversed. This is the theft
 *               vector, so it needs order.void, which a cashier does not have.
 */
export const VOID_STATUSES: readonly OrderStatus[] = ['VOIDED'];
