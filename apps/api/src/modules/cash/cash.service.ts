import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService, type TxClient } from '../../prisma/prisma.service';
import { PaymentMethod } from '../../generated/prisma/enums';
import type {
  CashMovementDto,
  CloseSessionDto,
  OpenSessionDto,
} from './dto/cash.dto';

/**
 * The cash drawer / day-close.
 *
 * A session opens with a float and closes with a physical count. Between
 * those two moments, the settlement is derived — never a running counter that
 * could drift:
 *
 *   expected cash = float + pay-ins − pay-outs + cash sales − cash refunds
 *   variance      = counted − expected            (negative = short)
 *
 * "Cash sales" and the payment-method breakdown are scoped to the session's
 * time window. The partial unique index (one OPEN session per tenant) is what
 * makes that window unambiguous.
 */
@Injectable()
export class CashService {
  constructor(private readonly prisma: PrismaService) {}

  /** Opens a session. 409 if one is already open (the unique index enforces it). */
  async open(dto: OpenSessionDto) {
    const ctx = this.prisma.requireContext();
    try {
      return await this.prisma.tx(async (db) => {
        const branch = await db.branch.findFirstOrThrow({
          where: { isActive: true },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        });
        const session = await db.cashSession.create({
          data: {
            restaurantId: ctx.restaurantId,
            branchId: branch.id,
            openingFloatMinor: dto.openingFloatMinor,
            openedByUserId: ctx.userId,
            notes: dto.notes ?? null,
          },
          select: SESSION_SELECT,
        });
        return this.withReport(db, session);
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException(
          'A till session is already open — close it before opening another',
        );
      }
      throw e;
    }
  }

  /** The open session with its live settlement, or null when the till is shut. */
  async current() {
    return this.prisma.tx(async (db) => {
      const session = await db.cashSession.findFirst({
        where: { status: 'OPEN' },
        select: SESSION_SELECT,
      });
      if (!session) return null;
      return this.withReport(db, session);
    });
  }

  /** Records a non-sale cash movement against the open session. */
  async recordMovement(sessionId: string, dto: CashMovementDto) {
    const ctx = this.prisma.requireContext();
    return this.prisma.tx(async (db) => {
      const session = await db.cashSession.findFirst({
        where: { id: sessionId },
        select: { id: true, status: true },
      });
      if (!session) throw new NotFoundException('Session not found');
      if (session.status !== 'OPEN') {
        throw new ConflictException('The till session is closed');
      }
      await db.cashMovement.create({
        data: {
          restaurantId: ctx.restaurantId,
          sessionId,
          type: dto.type,
          amountMinor: dto.amountMinor,
          reason: dto.reason,
          actorUserId: ctx.userId,
        },
      });
      const fresh = await db.cashSession.findFirstOrThrow({
        where: { id: sessionId },
        select: SESSION_SELECT,
      });
      return this.withReport(db, fresh);
    });
  }

  /**
   * Closes the session: snapshots the expected cash and the variance so the
   * Z-report reprints identically forever, then marks it CLOSED.
   */
  async close(sessionId: string, dto: CloseSessionDto) {
    const ctx = this.prisma.requireContext();
    return this.prisma.tx(async (db) => {
      const session = await db.cashSession.findFirst({
        where: { id: sessionId },
        select: SESSION_SELECT,
      });
      if (!session) throw new NotFoundException('Session not found');
      if (session.status !== 'OPEN') {
        throw new ConflictException('The till session is already closed');
      }

      const report = await this.settlement(db, session, new Date());
      const variance = dto.closingCountedMinor - report.expectedCashMinor;

      const closed = await db.cashSession.update({
        where: { id: sessionId },
        data: {
          status: 'CLOSED',
          closedByUserId: ctx.userId,
          closedAt: new Date(),
          closingCountedMinor: dto.closingCountedMinor,
          expectedCashMinor: report.expectedCashMinor,
          varianceMinor: variance,
          // Append the close note rather than clobbering the open note.
          notes: dto.notes ?? session.notes,
        },
        select: SESSION_SELECT,
      });
      return this.withReport(db, closed);
    });
  }

  /** Recent sessions (history), newest first. */
  list() {
    return this.prisma.tx((db) =>
      db.cashSession.findMany({
        take: 50,
        orderBy: { openedAt: 'desc' },
        select: SESSION_SELECT,
      }),
    );
  }

  /** One session with its settlement — live if open, snapshot if closed. */
  async getById(id: string) {
    return this.prisma.tx(async (db) => {
      const session = await db.cashSession.findFirst({
        where: { id },
        select: SESSION_SELECT,
      });
      if (!session) throw new NotFoundException('Session not found');
      return this.withReport(db, session);
    });
  }

  // -- settlement -----------------------------------------------------------

  private async withReport(db: TxClient, session: SessionRow) {
    const until = session.closedAt ?? new Date();
    const report = await this.settlement(db, session, until);
    const movements = await db.cashMovement.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        type: true,
        amountMinor: true,
        reason: true,
        createdAt: true,
      },
    });
    return { ...session, movements, report };
  }

  /**
   * The money picture for a session window. For a CLOSED session the snapshot
   * on the row is authoritative; the recomputation here matches it by
   * construction because it reads the same immutable rows over the same window.
   */
  private async settlement(db: TxClient, session: SessionRow, until: Date) {
    const window = { gte: session.openedAt, lte: until };

    // Serial, not Promise.all: concurrent queries share this transaction's one
    // pg connection — unsafe under @prisma/adapter-pg (removed in pg v9).
    const [payAgg, refundAgg, movementAgg] = [
      await db.payment.groupBy({
        by: ['method'],
        where: { status: 'CAPTURED', createdAt: window },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      await db.refund.groupBy({
        by: ['method'],
        where: { createdAt: window },
        _sum: { amountMinor: true },
      }),
      await db.cashMovement.groupBy({
        by: ['type'],
        where: { sessionId: session.id },
        _sum: { amountMinor: true },
      }),
    ];

    const sum = (
      rows: Array<{ method: string; _sum: { amountMinor: number | null } }>,
      method: string,
    ) => rows.find((r) => r.method === method)?._sum.amountMinor ?? 0;

    const payByMethod = Object.values(PaymentMethod).map((method) => ({
      method,
      amountMinor: sum(payAgg, method),
      count: payAgg.find((r) => r.method === method)?._count._all ?? 0,
    }));
    const refundByMethod = Object.values(PaymentMethod)
      .map((method) => ({ method, amountMinor: sum(refundAgg, method) }))
      .filter((r) => r.amountMinor > 0);

    const cashSalesMinor = sum(payAgg, PaymentMethod.CASH);
    const cashRefundsMinor = sum(refundAgg, PaymentMethod.CASH);
    const payInMinor =
      movementAgg.find((m) => m.type === 'PAY_IN')?._sum.amountMinor ?? 0;
    const payOutMinor =
      movementAgg.find((m) => m.type === 'PAY_OUT')?._sum.amountMinor ?? 0;

    const expectedCashMinor =
      session.openingFloatMinor +
      payInMinor -
      payOutMinor +
      cashSalesMinor -
      cashRefundsMinor;

    const grossSalesMinor = payByMethod.reduce((s, r) => s + r.amountMinor, 0);
    const refundsMinor = refundByMethod.reduce((s, r) => s + r.amountMinor, 0);

    return {
      openingFloatMinor: session.openingFloatMinor,
      payInMinor,
      payOutMinor,
      cashSalesMinor,
      cashRefundsMinor,
      expectedCashMinor,
      grossSalesMinor,
      netSalesMinor: grossSalesMinor - refundsMinor,
      refundsMinor,
      payByMethod,
      refundByMethod,
      // Present only after close; null while the drawer is still live.
      countedCashMinor: session.closingCountedMinor,
      varianceMinor:
        session.status === 'CLOSED'
          ? (session.closingCountedMinor ?? 0) - expectedCashMinor
          : null,
    };
  }
}

const SESSION_SELECT = {
  id: true,
  status: true,
  branchId: true,
  openingFloatMinor: true,
  openedByUserId: true,
  openedAt: true,
  closedByUserId: true,
  closedAt: true,
  closingCountedMinor: true,
  expectedCashMinor: true,
  varianceMinor: true,
  notes: true,
} as const;

type SessionRow = {
  id: string;
  status: string;
  openingFloatMinor: number;
  openedAt: Date;
  closedAt: Date | null;
  closingCountedMinor: number | null;
};

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002';
}
