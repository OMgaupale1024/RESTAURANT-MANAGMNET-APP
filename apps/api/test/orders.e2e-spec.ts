/**
 * Orders end-to-end: lifecycle, timeline, and who may do what.
 *
 * The tests that matter: illegal transitions, and a cashier trying to void.
 */
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaPg } from '@prisma/adapter-pg';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaClient } from '../src/generated/prisma/client';

const password = 'correct-horse-battery';
let app: NestExpressApplication;

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

let ipCounter = 300000;
function api() {
  ipCounter++;
  const ip = `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
  const server = app.getHttpServer();
  return {
    post: (url: string) => request(server).post(url).set('X-Forwarded-For', ip),
    get: (url: string) => request(server).get(url).set('X-Forwarded-For', ip),
    patch: (url: string) =>
      request(server).patch(url).set('X-Forwarded-For', ip),
  };
}

/** Owner with a restaurant, one product, and a restaurant-scoped token. */
async function newTenant(name: string) {
  const email = `o-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Order Owner' })
    .expect(201);
  const cookie = reg.headers['set-cookie'][0].split(';')[0];

  const created = await api()
    .post('/api/v1/restaurants')
    .set('Authorization', `Bearer ${reg.body.accessToken}`)
    .send({ name })
    .expect(201);

  const scoped = await api()
    .post('/api/v1/auth/select-restaurant')
    .set('Authorization', `Bearer ${reg.body.accessToken}`)
    .set('Cookie', cookie)
    .send({ restaurantId: created.body.restaurant.id })
    .expect(200);

  const token = scoped.body.accessToken as string;
  const product = await api()
    .post('/api/v1/products')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Momo', priceMinor: 10000 })
    .expect(201);

  return {
    email,
    token,
    restaurantId: created.body.restaurant.id as string,
    userId: reg.body.accessToken
      ? (
          JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()) as {
            sub: string;
          }
        ).sub
      : '',
    productId: product.body.id as string,
  };
}

const placeOrder = (t: { token: string; productId: string }) =>
  api()
    .post('/api/v1/orders')
    .set('Authorization', `Bearer ${t.token}`)
    .send({ items: [{ productId: t.productId, quantity: 1 }] });

const setStatus = (
  token: string,
  id: string,
  status: string,
  reason?: string,
) =>
  api()
    .patch(`/api/v1/orders/${id}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send(reason ? { status, reason } : { status });

/**
 * Demotes a tenant's own membership to another role, then re-issues their
 * token. Used to test what a CASHIER can and cannot do without inventing a
 * second signup flow (staff invites are a later step).
 */
async function becomeRole(
  t: { token: string; restaurantId: string; email: string },
  roleKey: string,
) {
  const role = await owner.role.findUniqueOrThrow({ where: { key: roleKey } });
  const user = await owner.user.findUniqueOrThrow({
    where: { email: t.email },
  });
  await owner.membership.updateMany({
    where: { userId: user.id, restaurantId: t.restaurantId },
    data: { roleId: role.id },
  });

  const login = await api()
    .post('/api/v1/auth/login')
    .send({ email: t.email, password })
    .expect(200);
  return login.body.accessToken as string;
}

describe('Orders (e2e)', () => {
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.use(cookieParser());
    app.set('trust proxy', 1);
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    for (const t of [
      'audit_logs',
      'order_events',
      'security_events',
      'orders',
    ]) {
      await owner.$executeRawUnsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    }
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 'o-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      await owner.restaurant.deleteMany({
        where: { id: { in: ms.map((m) => m.restaurantId) } },
      });
      await owner.securityEvent.deleteMany({
        where: { email: { startsWith: 'o-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 'o-' } } });
    } finally {
      for (const t of [
        'audit_logs',
        'order_events',
        'security_events',
        'orders',
      ]) {
        await owner.$executeRawUnsafe(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
      }
      await owner.$disconnect();
    }
    await app.close();
  });

  describe('listing', () => {
    it('lists the tenant orders, newest first', async () => {
      const t = await newTenant('List Cafe');
      await placeOrder(t).expect(201);
      await placeOrder(t).expect(201);

      const res = await api()
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].orderNumber).toBe(2); // newest first
    });

    it('filters by status', async () => {
      const t = await newTenant('Filter Cafe');
      const o1 = await placeOrder(t).expect(201);
      await placeOrder(t).expect(201);
      await setStatus(t.token, o1.body.id, 'PREPARING').expect(200);

      const res = await api()
        .get('/api/v1/orders?status=PREPARING')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(o1.body.id);
    });

    it('rejects an invalid status filter', async () => {
      const t = await newTenant('Bad Filter Cafe');
      await api()
        .get('/api/v1/orders?status=NONSENSE')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(400);
    });

    it("never lists another tenant's orders", async () => {
      const a = await newTenant('Orders A');
      const b = await newTenant('Orders B');
      await placeOrder(a).expect(201);

      const res = await api()
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${b.token}`)
        .expect(200);
      expect(res.body).toHaveLength(0);
    });
  });

  describe('status transitions', () => {
    it('walks the happy path PLACED -> PREPARING -> READY -> COMPLETED', async () => {
      const t = await newTenant('Happy Cafe');
      const o = await placeOrder(t).expect(201);

      for (const status of ['PREPARING', 'READY', 'COMPLETED']) {
        const res = await setStatus(t.token, o.body.id, status).expect(200);
        expect(res.body.status).toBe(status);
      }
    });

    it('refuses a skipped step (PLACED -> COMPLETED without paying)', async () => {
      const t = await newTenant('Skip Cafe');
      const o = await placeOrder(t).expect(201);
      await setStatus(t.token, o.body.id, 'COMPLETED').expect(409);
    });

    it('refuses to resurrect a terminal order', async () => {
      const t = await newTenant('Terminal Cafe');
      const o = await placeOrder(t).expect(201);
      await setStatus(t.token, o.body.id, 'CANCELLED').expect(200);
      // A cancelled order must never come back.
      await setStatus(t.token, o.body.id, 'PREPARING').expect(409);
      await setStatus(t.token, o.body.id, 'COMPLETED').expect(409);
    });

    it('is idempotent for a repeated status', async () => {
      const t = await newTenant('Idem Status Cafe');
      const o = await placeOrder(t).expect(201);
      await setStatus(t.token, o.body.id, 'PREPARING').expect(200);
      // A double-tapped button is not an error.
      const again = await setStatus(t.token, o.body.id, 'PREPARING').expect(
        200,
      );
      expect(again.body.status).toBe('PREPARING');
    });

    it('rejects a status outside the enum', async () => {
      const t = await newTenant('Enum Cafe');
      const o = await placeOrder(t).expect(201);
      await setStatus(t.token, o.body.id, 'FREE_FOOD').expect(400);
    });

    it("cannot transition another tenant's order", async () => {
      const a = await newTenant('Trans A');
      const b = await newTenant('Trans B');
      const o = await placeOrder(a).expect(201);
      // Valid token, someone else's order.
      await setStatus(b.token, o.body.id, 'CANCELLED').expect(404);
    });

    it('leaves the totals untouched through the lifecycle', async () => {
      const t = await newTenant('Money Cafe');
      const o = await placeOrder(t).expect(201);
      const before = o.body.totalMinor;

      await setStatus(t.token, o.body.id, 'PREPARING').expect(200);
      const after = await setStatus(t.token, o.body.id, 'READY').expect(200);
      expect(after.body.totalMinor).toBe(before);
    });
  });

  describe('voiding (the theft vector)', () => {
    it('an owner may void, and it is written to the audit log', async () => {
      const t = await newTenant('Void Cafe');
      const o = await placeOrder(t).expect(201);

      const res = await setStatus(
        t.token,
        o.body.id,
        'VOIDED',
        'wrong order',
      ).expect(200);
      expect(res.body.status).toBe('VOIDED');

      const logs = await owner.auditLog.findMany({
        where: { restaurantId: t.restaurantId, action: 'order.voided' },
      });
      expect(logs).toHaveLength(1);
      expect((logs[0].metadata as { reason: string }).reason).toBe(
        'wrong order',
      );
    });

    it('a CASHIER cannot void, even though they can change status', async () => {
      const t = await newTenant('Cashier Cafe');
      const o = await placeOrder(t).expect(201);

      const cashierToken = await becomeRole(t, 'CASHIER');

      // The cashier CAN move the order along...
      await api()
        .patch(`/api/v1/orders/${o.body.id}/status`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ status: 'PREPARING' })
        .expect(200);

      // ...but must NOT be able to make the sale disappear.
      await api()
        .patch(`/api/v1/orders/${o.body.id}/status`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ status: 'VOIDED', reason: 'oops' })
        .expect(403);
    });

    it('a KITCHEN user cannot create orders', async () => {
      const t = await newTenant('Kitchen Cafe');
      const kitchenToken = await becomeRole(t, 'KITCHEN');
      await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${kitchenToken}`)
        .send({ items: [{ productId: t.productId, quantity: 1 }] })
        .expect(403);
    });
  });

  describe('timeline', () => {
    it('records every transition, in order, with the actor', async () => {
      const t = await newTenant('Timeline Cafe');
      const o = await placeOrder(t).expect(201);
      await setStatus(t.token, o.body.id, 'PREPARING').expect(200);
      await setStatus(t.token, o.body.id, 'READY').expect(200);

      const res = await api()
        .get(`/api/v1/orders/${o.body.id}/timeline`)
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);

      expect(res.body).toHaveLength(3);
      expect(res.body[0].type).toBe('CREATED');
      expect(res.body[1]).toMatchObject({
        type: 'STATUS_CHANGED',
        fromStatus: 'PLACED',
        toStatus: 'PREPARING',
      });
      expect(res.body[2].toStatus).toBe('READY');
      expect(res.body[1].actorUserId).toBeTruthy();
    });

    it('cannot be rewritten, even by the app role (append-only)', async () => {
      const t = await newTenant('Immutable Timeline');
      const o = await placeOrder(t).expect(201);
      await setStatus(t.token, o.body.id, 'CANCELLED', 'changed mind').expect(
        200,
      );

      const appDb = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: process.env.DATABASE_URL_APP,
        }),
      });
      try {
        // Covering tracks: rewrite the reason a void/cancel happened.
        await expect(
          appDb.$transaction(async (db) => {
            await db.$executeRaw`SELECT set_config('app.restaurant_id', ${t.restaurantId}, true)`;
            return db.orderEvent.updateMany({
              where: { orderId: o.body.id },
              data: { metadata: { reason: 'nothing to see here' } },
            });
          }),
        ).rejects.toThrow();
      } finally {
        await appDb.$disconnect();
      }
    });

    it("cannot read another tenant's timeline", async () => {
      const a = await newTenant('TL A');
      const b = await newTenant('TL B');
      const o = await placeOrder(a).expect(201);
      await api()
        .get(`/api/v1/orders/${o.body.id}/timeline`)
        .set('Authorization', `Bearer ${b.token}`)
        .expect(404);
    });
  });
});
