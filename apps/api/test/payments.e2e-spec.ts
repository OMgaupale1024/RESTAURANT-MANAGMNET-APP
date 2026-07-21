/**
 * Payments and refunds end-to-end.
 *
 * The rules that matter: captured payments never exceed the total, refunds
 * never exceed what was captured, money-out demands order.refund and a
 * reason, and every movement lands on the order's timeline.
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

let ipCounter = 700000;
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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Tenant + one product; returns a helper that places an order. */
async function newTenant() {
  const email = `pay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Pay Owner' })
    .expect(201);
  const cookie = reg.headers['set-cookie'][0].split(';')[0];
  const created = await api()
    .post('/api/v1/restaurants')
    .set(auth(reg.body.accessToken))
    .send({ name: `Pay Cafe ${Date.now()}` })
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
    // 100.00 + 5% GST = 105.00 per unit — round numbers for assertions.
    .send({ name: 'Plate Momo', priceMinor: 10000, taxRateBp: 500 })
    .expect(201);

  const placeOrder = async (opts: Record<string, unknown> = {}) => {
    const res = await api()
      .post('/api/v1/orders')
      .set(auth(token))
      .send({
        items: [{ productId: product.body.id, quantity: 1 }],
        idempotencyKey: randomUUID(),
        ...opts,
      })
      .expect(201);
    return res.body as { id: string; totalMinor: number };
  };

  return { token, placeOrder };
}

const pay = (token: string, orderId: string, body: Record<string, unknown>) =>
  api()
    .post(`/api/v1/orders/${orderId}/payments`)
    .set(auth(token))
    .send({ idempotencyKey: randomUUID(), ...body });

const refund = (
  token: string,
  orderId: string,
  body: Record<string, unknown>,
) =>
  api()
    .post(`/api/v1/orders/${orderId}/refunds`)
    .set(auth(token))
    .send({ idempotencyKey: randomUUID(), ...body });

const setStatus = (
  token: string,
  orderId: string,
  status: string,
  reason?: string,
) =>
  api()
    .patch(`/api/v1/orders/${orderId}/status`)
    .set(auth(token))
    .send({ status, ...(reason ? { reason } : {}) });

describe('Payments & refunds (e2e)', () => {
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
      'refunds',
    ]) {
      await owner.$executeRawUnsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    }
    await owner.$executeRawUnsafe(`ALTER TABLE orders DISABLE TRIGGER USER`);
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 'pay-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      const ids = ms.map((m) => m.restaurantId);
      await owner.refund.deleteMany({ where: { restaurantId: { in: ids } } });
      await owner.product.deleteMany({ where: { restaurantId: { in: ids } } });
      await owner.category.deleteMany({ where: { restaurantId: { in: ids } } });
      await owner.restaurant.deleteMany({ where: { id: { in: ids } } });
      await owner.securityEvent.deleteMany({
        where: { email: { startsWith: 'pay-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 'pay-' } } });
    } finally {
      for (const t of [
        'audit_logs',
        'order_events',
        'security_events',
        'refunds',
        'orders',
      ]) {
        await owner.$executeRawUnsafe(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
      }
      await owner.$disconnect();
    }
    await app.close();
  });

  describe('recording payments', () => {
    it('collects split legs up to the total and not a paisa more', async () => {
      const t = await newTenant();
      const order = await t.placeOrder(); // no paymentMethod — unpaid

      // Total is 10500 (10000 + 5%). Leg 1: cash 4000.
      await pay(t.token, order.id, {
        method: 'CASH',
        amountMinor: 4000,
      }).expect(201);
      // Overpay attempt: 7000 > 6500 remaining.
      await pay(t.token, order.id, { method: 'UPI', amountMinor: 7000 }).expect(
        400,
      );
      // Exact remainder closes it out.
      const done = await pay(t.token, order.id, {
        method: 'UPI',
        amountMinor: 6500,
      }).expect(201);

      expect(done.body.payments).toHaveLength(2);
      const sum = done.body.payments.reduce(
        (s: number, p: { amountMinor: number }) => s + p.amountMinor,
        0,
      );
      expect(sum).toBe(order.totalMinor);

      // Fully paid: the next paisa is refused.
      await pay(t.token, order.id, { method: 'CASH', amountMinor: 1 }).expect(
        400,
      );
    });

    it('resolves a pay-later order and shows it on the timeline', async () => {
      const t = await newTenant();
      const order = await t.placeOrder();

      await pay(t.token, order.id, {
        method: 'CASH',
        amountMinor: order.totalMinor,
      }).expect(201);

      const timeline = await api()
        .get(`/api/v1/orders/${order.id}/timeline`)
        .set(auth(t.token))
        .expect(200);
      const types = timeline.body.map((e: { type: string }) => e.type);
      expect(types).toContain('PAYMENT_RECORDED');
    });

    it('replays an idempotency key instead of double-charging', async () => {
      const t = await newTenant();
      const order = await t.placeOrder();
      const key = randomUUID();

      await pay(t.token, order.id, {
        method: 'CASH',
        amountMinor: 5000,
        idempotencyKey: key,
      }).expect(201);
      const replay = await pay(t.token, order.id, {
        method: 'CASH',
        amountMinor: 5000,
        idempotencyKey: key,
      }).expect(201);

      expect(replay.body.payments).toHaveLength(1);
    });

    it('refuses payments on a reversed order', async () => {
      const t = await newTenant();
      const order = await t.placeOrder();
      await setStatus(t.token, order.id, 'CANCELLED', 'test').expect(200);

      await pay(t.token, order.id, { method: 'CASH', amountMinor: 100 }).expect(
        409,
      );
    });

    it("cannot pay another tenant's order", async () => {
      const a = await newTenant();
      const b = await newTenant();
      const order = await a.placeOrder();

      await pay(b.token, order.id, { method: 'CASH', amountMinor: 100 }).expect(
        404,
      );
    });
  });

  describe('recording refunds', () => {
    /** Paid + completed order — the normal refund target. */
    async function paidCompleted(t: Awaited<ReturnType<typeof newTenant>>) {
      const order = await t.placeOrder({ paymentMethod: 'CASH' });
      await setStatus(t.token, order.id, 'PREPARING').expect(200);
      await setStatus(t.token, order.id, 'READY').expect(200);
      await setStatus(t.token, order.id, 'COMPLETED').expect(200);
      return order;
    }

    it('refunds up to the captured amount, never beyond', async () => {
      const t = await newTenant();
      const order = await paidCompleted(t);

      await refund(t.token, order.id, {
        method: 'CASH',
        amountMinor: 4000,
        reason: 'Cold momos — partial refund',
      }).expect(201);

      // 10500 captured, 4000 refunded → 6500 left. 7000 must fail.
      await refund(t.token, order.id, {
        method: 'CASH',
        amountMinor: 7000,
        reason: 'Too much',
      }).expect(400);

      const rest = await refund(t.token, order.id, {
        method: 'CASH',
        amountMinor: 6500,
        reason: 'Full reversal on complaint',
      }).expect(201);
      expect(rest.body.refunds).toHaveLength(2);

      await refund(t.token, order.id, {
        method: 'CASH',
        amountMinor: 1,
        reason: 'Nothing left',
      }).expect(400);
    });

    it('demands a reason', async () => {
      const t = await newTenant();
      const order = await paidCompleted(t);
      await refund(t.token, order.id, {
        method: 'CASH',
        amountMinor: 100,
        reason: '',
      }).expect(400);
    });

    it('refuses refunds while the order is still live', async () => {
      const t = await newTenant();
      const order = await t.placeOrder({ paymentMethod: 'CASH' });
      await refund(t.token, order.id, {
        method: 'CASH',
        amountMinor: 100,
        reason: 'Too early',
      }).expect(409);
    });

    it('a voided order refunds its captured payment and hits the audit trail', async () => {
      const t = await newTenant();
      const order = await t.placeOrder({ paymentMethod: 'UPI' });
      await setStatus(t.token, order.id, 'VOIDED', 'wrong order').expect(200);

      const res = await refund(t.token, order.id, {
        method: 'UPI',
        amountMinor: order.totalMinor,
        reason: 'Void — UPI reversed at counter',
      }).expect(201);
      expect(res.body.refunds[0].amountMinor).toBe(order.totalMinor);

      const timeline = await api()
        .get(`/api/v1/orders/${order.id}/timeline`)
        .set(auth(t.token))
        .expect(200);
      expect(timeline.body.map((e: { type: string }) => e.type)).toContain(
        'REFUND_RECORDED',
      );
    });

    it("cannot refund another tenant's order", async () => {
      const a = await newTenant();
      const b = await newTenant();
      const order = await a.placeOrder({ paymentMethod: 'CASH' });
      await setStatus(a.token, order.id, 'VOIDED', 'x').expect(200);

      await refund(b.token, order.id, {
        method: 'CASH',
        amountMinor: 100,
        reason: 'attack',
      }).expect(404);
    });
  });
});
