/**
 * Cash drawer / day-close end-to-end.
 *
 * The correctness that matters: one open session per tenant, the settlement
 * derives expected cash from real payments in the window, and the close
 * variance is counted − expected.
 */
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaPg } from '@prisma/adapter-pg';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function newTenant() {
  const email = `cash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Cash Owner' })
    .expect(201);
  const cookie = reg.headers['set-cookie'][0].split(';')[0];
  const created = await api()
    .post('/api/v1/restaurants')
    .set(auth(reg.body.accessToken))
    .send({ name: `Cash Cafe ${Date.now()}` })
    .expect(201);
  const scoped = await api()
    .post('/api/v1/auth/select-restaurant')
    .set(auth(reg.body.accessToken))
    .set('Cookie', cookie)
    .send({ restaurantId: created.body.restaurant.id })
    .expect(200);
  const token = scoped.body.accessToken as string;
  const product = await api()
    .post('/api/v1/products')
    .set(auth(token))
    .send({ name: 'Plate Momo', priceMinor: 10000, taxRateBp: 500 })
    .expect(201);
  return { token, productId: product.body.id as string };
}

const open = (token: string, body: Record<string, unknown>) =>
  api().post('/api/v1/cash/sessions').set(auth(token)).send(body);

const payCashOrder = (token: string, productId: string) =>
  api()
    .post('/api/v1/orders')
    .set(auth(token))
    .send({
      items: [{ productId, quantity: 1 }],
      paymentMethod: 'CASH',
      idempotencyKey: randomUUID(),
    });

describe('Cash drawer (e2e)', () => {
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
    for (const tbl of [
      'audit_logs',
      'order_events',
      'security_events',
      'cash_movements',
    ]) {
      await owner.$executeRawUnsafe(`ALTER TABLE ${tbl} DISABLE TRIGGER USER`);
    }
    await owner.$executeRawUnsafe(`ALTER TABLE orders DISABLE TRIGGER USER`);
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 'cash-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      const ids = ms.map((m) => m.restaurantId);
      await owner.cashMovement.deleteMany({
        where: { restaurantId: { in: ids } },
      });
      await owner.cashSession.deleteMany({
        where: { restaurantId: { in: ids } },
      });
      await owner.product.deleteMany({ where: { restaurantId: { in: ids } } });
      await owner.restaurant.deleteMany({ where: { id: { in: ids } } });
      await owner.securityEvent.deleteMany({
        where: { email: { startsWith: 'cash-' } },
      });
      await owner.user.deleteMany({
        where: { email: { startsWith: 'cash-' } },
      });
    } finally {
      for (const tbl of [
        'audit_logs',
        'order_events',
        'security_events',
        'cash_movements',
        'orders',
      ]) {
        await owner.$executeRawUnsafe(`ALTER TABLE ${tbl} ENABLE TRIGGER USER`);
      }
      await owner.$disconnect();
    }
    await app.close();
  });

  it('opens a session and refuses a second while it is open', async () => {
    const t = await newTenant();
    const s = await open(t.token, { openingFloatMinor: 200000 }).expect(201);
    expect(s.body.status).toBe('OPEN');
    expect(s.body.report.expectedCashMinor).toBe(200000);

    // Second open is a 409 (partial unique index enforces one open per tenant).
    await open(t.token, { openingFloatMinor: 500 }).expect(409);

    const cur = await api()
      .get('/api/v1/cash/sessions/current')
      .set(auth(t.token))
      .expect(200);
    expect(cur.body.id).toBe(s.body.id);
  });

  it('counts cash sales and pay-in/out into the expected drawer', async () => {
    const t = await newTenant();
    const s = await open(t.token, { openingFloatMinor: 200000 }).expect(201);

    // A cash order of 10500 (100 + 5% GST).
    await payCashOrder(t.token, t.productId).expect(201);

    // Cash in 5000 (change top-up), cash out 3000 (supplier).
    await api()
      .post(`/api/v1/cash/sessions/${s.body.id}/movements`)
      .set(auth(t.token))
      .send({ type: 'PAY_IN', amountMinor: 5000, reason: 'change' })
      .expect(201);
    const after = await api()
      .post(`/api/v1/cash/sessions/${s.body.id}/movements`)
      .set(auth(t.token))
      .send({ type: 'PAY_OUT', amountMinor: 3000, reason: 'supplier' })
      .expect(201);

    const r = after.body.report;
    expect(r.cashSalesMinor).toBe(10500);
    expect(r.payInMinor).toBe(5000);
    expect(r.payOutMinor).toBe(3000);
    // 200000 + 5000 − 3000 + 10500 = 212500
    expect(r.expectedCashMinor).toBe(212500);
    // CASH row in the method breakdown.
    const cash = r.payByMethod.find(
      (p: { method: string }) => p.method === 'CASH',
    );
    expect(cash.amountMinor).toBe(10500);
    expect(cash.count).toBe(1);
  });

  it('closes with a count, computes variance, and snapshots the report', async () => {
    const t = await newTenant();
    const s = await open(t.token, { openingFloatMinor: 200000 }).expect(201);
    await payCashOrder(t.token, t.productId).expect(201); // +10500 cash

    // Expected = 210500. Count 210000 → short 500.
    const closed = await api()
      .post(`/api/v1/cash/sessions/${s.body.id}/close`)
      .set(auth(t.token))
      .send({ closingCountedMinor: 210000 })
      .expect(201);
    expect(closed.body.status).toBe('CLOSED');
    expect(closed.body.expectedCashMinor).toBe(210500);
    expect(closed.body.varianceMinor).toBe(-500);
    expect(closed.body.closedAt).not.toBeNull();

    // current() now reports the till is shut.
    // A null session serializes as an empty body — no id present.
    const cur = await api()
      .get('/api/v1/cash/sessions/current')
      .set(auth(t.token))
      .expect(200);
    expect(cur.body.id).toBeUndefined();

    // The snapshot is stable: re-reading the closed session matches.
    const reread = await api()
      .get(`/api/v1/cash/sessions/${s.body.id}`)
      .set(auth(t.token))
      .expect(200);
    expect(reread.body.varianceMinor).toBe(-500);
    expect(reread.body.report.varianceMinor).toBe(-500);

    // A fresh session can now open.
    await open(t.token, { openingFloatMinor: 100000 }).expect(201);
  });

  it('cannot record a movement on a closed session', async () => {
    const t = await newTenant();
    const s = await open(t.token, { openingFloatMinor: 100000 }).expect(201);
    await api()
      .post(`/api/v1/cash/sessions/${s.body.id}/close`)
      .set(auth(t.token))
      .send({ closingCountedMinor: 100000 })
      .expect(201);
    await api()
      .post(`/api/v1/cash/sessions/${s.body.id}/movements`)
      .set(auth(t.token))
      .send({ type: 'PAY_IN', amountMinor: 100, reason: 'late' })
      .expect(409);
  });

  it('a cash movement requires a reason', async () => {
    const t = await newTenant();
    const s = await open(t.token, { openingFloatMinor: 100000 }).expect(201);
    await api()
      .post(`/api/v1/cash/sessions/${s.body.id}/movements`)
      .set(auth(t.token))
      .send({ type: 'PAY_OUT', amountMinor: 500, reason: '' })
      .expect(400);
  });

  it("cannot see or touch another tenant's session", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const s = await open(a.token, { openingFloatMinor: 100000 }).expect(201);

    // B's "current" is independent (null — B has none).
    const bCur = await api()
      .get('/api/v1/cash/sessions/current')
      .set(auth(b.token))
      .expect(200);
    expect(bCur.body.id).toBeUndefined();

    // B cannot read A's session by id (RLS → 404).
    await api()
      .get(`/api/v1/cash/sessions/${s.body.id}`)
      .set(auth(b.token))
      .expect(404);

    // B cannot close A's session.
    await api()
      .post(`/api/v1/cash/sessions/${s.body.id}/close`)
      .set(auth(b.token))
      .send({ closingCountedMinor: 0 })
      .expect(404);
  });
});
