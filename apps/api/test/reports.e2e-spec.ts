/**
 * Reports end-to-end.
 *
 * Reports adds only a custom date window over the same server-side aggregation
 * Analytics uses. The tests that matter here are the ones Reports introduces:
 * an explicit from/to window is honoured, a window with no sales is empty, the
 * date inputs are validated, aggregates stay tenant-scoped, and a cashier
 * cannot pull the books.
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

let ipCounter = 900000;
function api() {
  ipCounter++;
  const ip = `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
  const server = app.getHttpServer();
  return {
    post: (url: string) => request(server).post(url).set('X-Forwarded-For', ip),
    get: (url: string) => request(server).get(url).set('X-Forwarded-For', ip),
  };
}

async function newTenant(name: string) {
  const email = `rp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'A Report Owner' })
    .expect(201);
  const created = await api()
    .post('/api/v1/restaurants')
    .set('Authorization', `Bearer ${reg.body.accessToken}`)
    .send({ name })
    .expect(201);
  const cookie = reg.headers['set-cookie'][0].split(';')[0];
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
  return {
    email,
    token,
    restaurantId: created.body.restaurant.id as string,
    p1: p1.body.id as string,
  };
}

const placeOrder = (token: string, productId: string, quantity: number) =>
  api()
    .post('/api/v1/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ items: [{ productId, quantity }] });

const salesReport = (token: string, from: string, to: string) =>
  api()
    .get(`/api/v1/reports/sales?from=${from}&to=${to}`)
    .set('Authorization', `Bearer ${token}`);

/** Today and 30 days ago as YYYY-MM-DD, matching the client's default window. */
const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = iso(new Date());
const monthAgo = iso(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
const nextYear = iso(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000));
const twoYearsAgo = iso(new Date(Date.now() - 730 * 24 * 60 * 60 * 1000));

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

describe('Reports (e2e)', () => {
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
        where: { email: { startsWith: 'rp-' } },
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
        where: { email: { startsWith: 'rp-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 'rp-' } } });
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

  describe('window', () => {
    it('sums sales inside the requested window', async () => {
      const t = await newTenant('Report Window Cafe');
      await placeOrder(t.token, t.p1, 2).expect(201); // 2x10000 +5% = 21000

      const res = await salesReport(t.token, monthAgo, today).expect(200);
      expect(res.body.summary.orders).toBe(1);
      expect(res.body.summary.revenueMinor).toBe(21000);
      expect(res.body.summary.itemsSold).toBe(2);
      // The custom window echoes its own bounds, not a preset range.
      expect(res.body.range).toBeUndefined();
      expect(res.body.from).toBeDefined();
      expect(res.body.to).toBeDefined();
    });

    it('excludes an order placed outside the window', async () => {
      const t = await newTenant('Report Past Cafe');
      await placeOrder(t.token, t.p1, 1).expect(201); // today

      // A historical window that ends before today has no sales.
      const res = await salesReport(t.token, twoYearsAgo, twoYearsAgo).expect(
        200,
      );
      expect(res.body.summary.orders).toBe(0);
      expect(res.body.summary.revenueMinor).toBe(0);
      expect(res.body.revenueSeries).toEqual([]);
    });
  });

  describe('validation', () => {
    it('rejects a malformed date', async () => {
      const t = await newTenant('Report Bad Date Cafe');
      await salesReport(t.token, '18-07-2026', today).expect(400);
    });

    it('rejects a from after to', async () => {
      const t = await newTenant('Report Reversed Cafe');
      await salesReport(t.token, nextYear, today).expect(400);
    });

    it('rejects an impossible calendar date', async () => {
      const t = await newTenant('Report Impossible Cafe');
      await salesReport(t.token, '2026-13-40', today).expect(400);
    });
  });

  describe('tenant isolation', () => {
    it("never includes another tenant's sales", async () => {
      const a = await newTenant('Report Iso A');
      const b = await newTenant('Report Iso B');
      await placeOrder(a.token, a.p1, 5).expect(201);

      const bView = await salesReport(b.token, monthAgo, today).expect(200);
      expect(bView.body.summary.orders).toBe(0);
      expect(bView.body.summary.revenueMinor).toBe(0);
    });
  });

  describe('permissions', () => {
    it('a CASHIER cannot pull a report', async () => {
      const t = await newTenant('Report Cashier Cafe');
      const cashier = await becomeRole(t, 'CASHIER');
      await salesReport(cashier, monthAgo, today).expect(403);
    });

    it('rejects an unauthenticated request', async () => {
      await api()
        .get(`/api/v1/reports/sales?from=${monthAgo}&to=${today}`)
        .expect(401);
    });
  });
});
