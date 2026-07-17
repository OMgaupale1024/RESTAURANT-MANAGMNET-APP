/**
 * Analytics end-to-end.
 *
 * The tests that matter: aggregates are tenant-scoped (one restaurant's numbers
 * never include another's), voided/cancelled orders are excluded from revenue,
 * and a cashier cannot see the books.
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

let ipCounter = 800000;
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

async function newTenant(name: string) {
  const email = `an-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'An Owner' })
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
  const p1 = await api()
    .post('/api/v1/products')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Veg Momo', priceMinor: 10000 })
    .expect(201);
  const p2 = await api()
    .post('/api/v1/products')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Paneer Momo', priceMinor: 20000 })
    .expect(201);
  return {
    email,
    token,
    restaurantId: created.body.restaurant.id as string,
    p1: p1.body.id as string,
    p2: p2.body.id as string,
  };
}

const placeOrder = (
  token: string,
  items: Array<{ productId: string; quantity: number }>,
  paymentMethod?: string,
) =>
  api()
    .post('/api/v1/orders')
    .set('Authorization', `Bearer ${token}`)
    .send(paymentMethod ? { items, paymentMethod } : { items });

const overview = (token: string, range = '30d') =>
  api()
    .get(`/api/v1/analytics/overview?range=${range}`)
    .set('Authorization', `Bearer ${token}`);

async function becomeRole(
  t: { restaurantId: string; email: string },
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

describe('Analytics (e2e)', () => {
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
      'stock_movements',
    ]) {
      await owner.$executeRawUnsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    }
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 'an-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      const rids = ms.map((m) => m.restaurantId);
      await owner.order.deleteMany({ where: { restaurantId: { in: rids } } });
      await owner.restaurant.deleteMany({ where: { id: { in: rids } } });
      await owner.securityEvent.deleteMany({
        where: { email: { startsWith: 'an-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 'an-' } } });
    } finally {
      for (const t of [
        'audit_logs',
        'order_events',
        'security_events',
        'orders',
        'stock_movements',
      ]) {
        await owner.$executeRawUnsafe(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
      }
      await owner.$disconnect();
    }
    await app.close();
  });

  describe('summary', () => {
    it('sums revenue, orders, items and average bill', async () => {
      const t = await newTenant('Summary Cafe');
      // 1x10000 (+5%=10500), 2x20000 (+5%=42000). Two orders, 3 items.
      await placeOrder(
        t.token,
        [{ productId: t.p1, quantity: 1 }],
        'CASH',
      ).expect(201);
      await placeOrder(
        t.token,
        [{ productId: t.p2, quantity: 2 }],
        'UPI',
      ).expect(201);

      const res = await overview(t.token).expect(200);
      expect(res.body.summary.orders).toBe(2);
      expect(res.body.summary.revenueMinor).toBe(52500); // 10500 + 42000
      expect(res.body.summary.itemsSold).toBe(3);
      expect(res.body.summary.averageBillMinor).toBe(26250); // 52500 / 2
    });

    it('EXCLUDES voided and cancelled orders from revenue', async () => {
      const t = await newTenant('Void Analytics Cafe');
      const keep = await placeOrder(t.token, [
        { productId: t.p1, quantity: 1 },
      ]).expect(201);
      const voidIt = await placeOrder(t.token, [
        { productId: t.p2, quantity: 1 },
      ]).expect(201);

      await api()
        .patch(`/api/v1/orders/${voidIt.body.id}/status`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ status: 'VOIDED', reason: 'test' })
        .expect(200);

      const res = await overview(t.token).expect(200);
      // A reversed sale did not happen.
      expect(res.body.summary.orders).toBe(1);
      expect(res.body.summary.revenueMinor).toBe(keep.body.totalMinor);
    });
  });

  describe('breakdowns', () => {
    it('ranks top products by revenue', async () => {
      const t = await newTenant('Top Cafe');
      await placeOrder(t.token, [{ productId: t.p1, quantity: 1 }]).expect(201); // 10000 line
      await placeOrder(t.token, [{ productId: t.p2, quantity: 3 }]).expect(201); // 60000 line

      const res = await overview(t.token).expect(200);
      expect(res.body.topProducts[0].name).toBe('Paneer Momo');
      expect(res.body.topProducts[0].revenueMinor).toBe(60000);
      expect(res.body.topProducts[0].quantity).toBe(3);
      expect(res.body.topProducts[1].name).toBe('Veg Momo');
    });

    it('breaks payments down by method', async () => {
      const t = await newTenant('Pay Cafe');
      await placeOrder(
        t.token,
        [{ productId: t.p1, quantity: 1 }],
        'CASH',
      ).expect(201);
      await placeOrder(
        t.token,
        [{ productId: t.p1, quantity: 1 }],
        'CASH',
      ).expect(201);
      await placeOrder(
        t.token,
        [{ productId: t.p2, quantity: 1 }],
        'UPI',
      ).expect(201);

      const res = await overview(t.token).expect(200);
      const methods = Object.fromEntries(
        res.body.paymentBreakdown.map(
          (p: { method: string; count: number }) => [p.method, p.count],
        ),
      );
      expect(methods.CASH).toBe(2);
      expect(methods.UPI).toBe(1);
    });

    it('returns a 24-hour peak-hours axis', async () => {
      const t = await newTenant('Hours Cafe');
      await placeOrder(t.token, [{ productId: t.p1, quantity: 1 }]).expect(201);
      const res = await overview(t.token).expect(200);
      expect(res.body.peakHours).toHaveLength(24);
      // Every slot present, total equals the order count.
      const total = res.body.peakHours.reduce(
        (s: number, h: { orders: number }) => s + h.orders,
        0,
      );
      expect(total).toBe(1);
    });

    it('gives a revenue series with a bucket for the day an order was placed', async () => {
      const t = await newTenant('Series Cafe');
      await placeOrder(t.token, [{ productId: t.p1, quantity: 1 }]).expect(201);
      const res = await overview(t.token).expect(200);
      expect(res.body.revenueSeries.length).toBeGreaterThanOrEqual(1);
      const total = res.body.revenueSeries.reduce(
        (s: number, d: { revenueMinor: number }) => s + d.revenueMinor,
        0,
      );
      expect(total).toBe(10500);
    });
  });

  describe('empty state', () => {
    it('returns zeros for a restaurant with no orders', async () => {
      const t = await newTenant('Empty Analytics Cafe');
      const res = await overview(t.token).expect(200);
      expect(res.body.summary.revenueMinor).toBe(0);
      expect(res.body.summary.orders).toBe(0);
      expect(res.body.topProducts).toEqual([]);
      expect(res.body.peakHours).toHaveLength(24);
    });
  });

  describe('tenant isolation', () => {
    it("never includes another tenant's revenue", async () => {
      const a = await newTenant('Iso An A');
      const b = await newTenant('Iso An B');
      // A does lots of business; B does none.
      await placeOrder(a.token, [{ productId: a.p2, quantity: 5 }]).expect(201);

      const bView = await overview(b.token).expect(200);
      expect(bView.body.summary.revenueMinor).toBe(0);
      expect(bView.body.summary.orders).toBe(0);
      expect(bView.body.topProducts).toEqual([]);

      // And A sees only its own.
      const aView = await overview(a.token).expect(200);
      expect(aView.body.summary.orders).toBe(1);
    });
  });

  describe('permissions', () => {
    it('a CASHIER cannot see analytics', async () => {
      const t = await newTenant('Cashier Analytics Cafe');
      const cashier = await becomeRole(t, 'CASHIER');
      await overview(cashier).expect(403);
    });

    it('a MANAGER can see analytics', async () => {
      const t = await newTenant('Manager Analytics Cafe');
      const manager = await becomeRole(t, 'MANAGER');
      await overview(manager).expect(200);
    });

    it('rejects an unauthenticated request', async () => {
      await api().get('/api/v1/analytics/overview').expect(401);
    });

    it('rejects an invalid range', async () => {
      const t = await newTenant('Bad Range Cafe');
      await api()
        .get('/api/v1/analytics/overview?range=forever')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(400);
    });
  });
});
