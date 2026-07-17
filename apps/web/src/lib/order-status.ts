/**
 * Mirrors the server's state machine (apps/api/src/modules/orders/order-status.ts).
 *
 * This is a UI convenience — it decides which buttons to show. The server
 * enforces the same rules independently and is the only thing that matters;
 * a client that offers an illegal transition simply gets a 409.
 */
const NEXT: Record<string, string[]> = {
  DRAFT: ['PLACED', 'CANCELLED'],
  PLACED: ['PREPARING', 'CANCELLED', 'VOIDED'],
  PREPARING: ['READY', 'CANCELLED', 'VOIDED'],
  READY: ['COMPLETED', 'CANCELLED', 'VOIDED'],
  COMPLETED: [],
  CANCELLED: [],
  VOIDED: [],
};

export const nextStatuses = (from: string): string[] => NEXT[from] ?? [];

export const isTerminal = (s: string) => nextStatuses(s).length === 0;
