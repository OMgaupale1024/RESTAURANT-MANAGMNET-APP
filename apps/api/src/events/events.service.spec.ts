import { InternalServerErrorException } from '@nestjs/common';
import { EventsService, type EventInput } from './events.service';
import {
  tenantStorage,
  type TenantContext,
} from '../common/context/tenant-context';
import type { TxClient } from '../prisma/prisma.service';

/** The shape record() builds — typed so the mock stays free of `any`. */
type AuditData = {
  restaurantId: string;
  userId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
};

/** A tx client that records only what record() touches: auditLog.create. */
function fakeTx() {
  const create = jest.fn((_args: { data: AuditData }): Promise<unknown> =>
    Promise.resolve({}),
  );
  const db = { auditLog: { create } } as unknown as TxClient;
  return { db, create };
}

const CONTEXT: TenantContext = {
  userId: 'user-1',
  restaurantId: 'rest-1',
  membershipId: 'mem-1',
  permissions: [],
};

const run = <T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> =>
  tenantStorage.run(ctx, fn);

describe('EventsService', () => {
  const events = new EventsService();

  it('derives actor and tenant from context, and records the caller shape', async () => {
    const { db, create } = fakeTx();
    const input: EventInput = {
      action: 'order.voided',
      entityType: 'order',
      entityId: 'order-9',
      metadata: { orderNumber: 42, reason: null },
    };

    await run(CONTEXT, () => events.record(db, input));

    // Byte-identical to the shape the inline db.auditLog.create used to build —
    // this is what proves existing audit rows are unchanged by the refactor.
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        restaurantId: 'rest-1',
        userId: 'user-1',
        action: 'order.voided',
        entityType: 'order',
        entityId: 'order-9',
        metadata: { orderNumber: 42, reason: null },
      },
    });
  });

  it('ignores any actor/tenant a caller tries to smuggle in', async () => {
    const { db, create } = fakeTx();
    // Actor/tenant are not part of EventInput; if a caller forces them in, the
    // context still wins. This is the tenant-isolation guarantee.
    const smuggled = {
      restaurantId: 'attacker-tenant',
      userId: 'attacker-user',
      action: 'order.voided',
      entityType: 'order',
    } as unknown as EventInput;

    await run(CONTEXT, () => events.record(db, smuggled));

    const { data } = create.mock.calls[0][0];
    expect(data.restaurantId).toBe('rest-1');
    expect(data.userId).toBe('user-1');
  });

  it('passes metadata through and defaults entityId to null when absent', async () => {
    const { db, create } = fakeTx();
    await run(CONTEXT, () =>
      events.record(db, {
        action: 'staff.invite_revoked',
        entityType: 'staff_invite',
      }),
    );
    const { data } = create.mock.calls[0][0];
    expect(data.entityId).toBeNull();
    expect(data.metadata).toBeUndefined();
  });

  it('writes through the caller-supplied tx client, so a caller rollback discards it', async () => {
    // record() holds no PrismaService and opens no transaction of its own: it
    // can only write through the db it is handed. That IS the rollback
    // guarantee — if the caller's transaction aborts, this INSERT goes with it.
    const { db, create } = fakeTx();
    await run(CONTEXT, () =>
      events.record(db, { action: 'x.y', entityType: 'x' }),
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('fails closed when there is no tenant context at all', async () => {
    const { db, create } = fakeTx();
    await expect(
      events.record(db, { action: 'x.y', entityType: 'x' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(create).not.toHaveBeenCalled();
  });

  it('fails closed when authenticated but no restaurant is selected', async () => {
    const { db, create } = fakeTx();
    await expect(
      run({ ...CONTEXT, restaurantId: null }, () =>
        events.record(db, { action: 'x.y', entityType: 'x' }),
      ),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(create).not.toHaveBeenCalled();
  });
});
