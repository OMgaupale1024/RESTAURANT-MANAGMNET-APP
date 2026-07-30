/**
 * Loyalty foundation end-to-end.
 *
 * The rules that matter, and the ones a financial subsystem must never get
 * wrong: points are earned from net spend, the balance is the SUM of an
 * append-only ledger (never a stored counter), a redemption can never overspend
 * — not even under two tills racing — a refund reverses what its sale earned,
 * tier follows lifetime-earned, and every movement lands in the audit log.
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

let ipCounter = 720000;
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

/** Tenant + one product + one customer; helpers to place orders and read loyalty. */
async function newTenant() {
  const email = `loy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Loyalty Owner' })
    .expect(201);
  const cookie = reg.headers['set-cookie'][0].split(';')[0];
  const created = await api()
    .post('/api/v1/restaurants')
    .set(auth(reg.body.accessToken))
    .send({ name: `Loyalty Cafe ${Date.now()}` })
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
    // 100.00 + 5% GST. Net spend 10000 paise → 10 points per unit at ₹10/point.
    .send({ name: 'Plate Momo', priceMinor: 10000, taxRateBp: 500 })
    .expect(201);

  const customer = await api()
    .post('/api/v1/customers')
    .set(auth(token))
    .send({ name: 'Asha', phone: `9${Date.now().toString().slice(-9)}` })
    .expect(201);

  const placeOrder = async (opts: Record<string, unknown> = {}) => {
    const res = await api()
      .post('/api/v1/orders')
      .set(auth(token))
      .send({
        items: [{ productId: product.body.id, quantity: 1 }],
        customerId: customer.body.id,
        ...opts,
      })
      .expect(201);
    return res.body as {
      id: string;
      totalMinor: number;
      discountMinor: number;
    };
  };

  const summary = (customerId = customer.body.id as string) =>
    api().get(`/api/v1/customers/${customerId}/loyalty`).set(auth(token));

  return {
    token,
    restaurantId: created.body.restaurant.id,
    customerId: customer.body.id as string,
    placeOrder,
    summary,
  };
}

const earn = (token: string, orderId: string) =>
  api().post(`/api/v1/orders/${orderId}/loyalty/earn`).set(auth(token));
const reverse = (token: string, orderId: string) =>
  api().post(`/api/v1/orders/${orderId}/loyalty/reverse`).set(auth(token));
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
const redeem = (
  token: string,
  customerId: string,
  body: Record<string, unknown>,
) =>
  api()
    .post(`/api/v1/customers/${customerId}/loyalty/redeem`)
    .set(auth(token))
    .send(body);
const adjust = (
  token: string,
  customerId: string,
  body: Record<string, unknown>,
) =>
  api()
    .post(`/api/v1/customers/${customerId}/loyalty/adjust`)
    .set(auth(token))
    .send(body);
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

describe('Loyalty foundation (e2e)', () => {
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
    // The ledger and audit log are append-only by trigger — disable it to tidy
    // up, delete loyalty rows before their customer (FK is RESTRICT), re-enable.
    for (const t of [
      'audit_logs',
      'order_events',
      'security_events',
      'loyalty_ledger',
      'refunds',
      'orders',
    ]) {
      await owner.$executeRawUnsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    }
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 'loy-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      const ids = ms.map((m) => m.restaurantId);
      // FK order: loyalty and orders both RESTRICT-reference customers, so both
      // must go before the customer (orders cascade to items/payments/events).
      await owner.loyaltyLedger.deleteMany({
        where: { restaurantId: { in: ids } },
      });
      // Refunds reference orders; clear them (trigger disabled above) first.
      await owner.refund.deleteMany({ where: { restaurantId: { in: ids } } });
      await owner.order.deleteMany({ where: { restaurantId: { in: ids } } });
      await owner.customer.deleteMany({ where: { restaurantId: { in: ids } } });
      await owner.restaurant.deleteMany({ where: { id: { in: ids } } });
      await owner.securityEvent.deleteMany({
        where: { email: { startsWith: 'loy-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 'loy-' } } });
    } finally {
      for (const t of [
        'audit_logs',
        'order_events',
        'security_events',
        'loyalty_ledger',
        'refunds',
        'orders',
      ]) {
        await owner.$executeRawUnsafe(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
      }
      await owner.$disconnect();
    }
    await app.close();
  });

  describe('earning', () => {
    it('credits points from net spend, and does so only once', async () => {
      const t = await newTenant();
      const order = await t.placeOrder(); // subtotal 10000 → 10 points

      const first = await earn(t.token, order.id).expect(201);
      expect(first.body.balancePoints).toBe(10);
      expect(first.body.lifetimeEarnedPoints).toBe(10);

      // Replaying earn for the same order does not credit again.
      const again = await earn(t.token, order.id).expect(201);
      expect(again.body.balancePoints).toBe(10);

      const s = await t.summary().expect(200);
      expect(s.body.balancePoints).toBe(10);
      expect(s.body.recentEntries).toHaveLength(1);
      expect(s.body.recentEntries[0].type).toBe('EARN');
    });

    it('refuses to earn on an anonymous or a voided order', async () => {
      const t = await newTenant();

      const anon = await api()
        .post('/api/v1/orders')
        .set(auth(t.token))
        .send({ items: [{ productId: await productId(t.token), quantity: 1 }] })
        .expect(201);
      await earn(t.token, anon.body.id).expect(400);

      const order = await t.placeOrder();
      await setStatus(t.token, order.id, 'VOIDED', 'test').expect(200);
      await earn(t.token, order.id).expect(400);
    });
  });

  describe('tiers', () => {
    it('promotes by lifetime earned, and redeeming does not demote', async () => {
      const t = await newTenant();
      // Grant straight to GOLD (5000) via a manual adjustment.
      const granted = await adjust(t.token, t.customerId, {
        points: 5000,
        reason: 'migration credit',
      }).expect(201);
      expect(granted.body.tier.key).toBe('GOLD');
      expect(granted.body.nextTier.key).toBe('PLATINUM');

      // Spend most of it — balance drops, tier holds (lifetime-earned unchanged).
      const spent = await redeem(t.token, t.customerId, {
        points: 4900,
      }).expect(201);
      expect(spent.body.balancePoints).toBe(100);
      expect(spent.body.lifetimeEarnedPoints).toBe(5000);
      expect(spent.body.tier.key).toBe('GOLD');
    });
  });

  describe('redeeming', () => {
    it('never overspends the balance', async () => {
      const t = await newTenant();
      await adjust(t.token, t.customerId, {
        points: 100,
        reason: 'seed',
      }).expect(201);

      await redeem(t.token, t.customerId, { points: 150 }).expect(400); // insufficient
      const ok = await redeem(t.token, t.customerId, { points: 60 }).expect(
        201,
      );
      expect(ok.body.balancePoints).toBe(40);
      expect(ok.body.redeemedPoints).toBe(60);
    });

    it('replays an idempotency key instead of double-spending', async () => {
      const t = await newTenant();
      await adjust(t.token, t.customerId, {
        points: 100,
        reason: 'seed',
      }).expect(201);
      const key = `redeem-${Date.now()}`;

      await redeem(t.token, t.customerId, {
        points: 30,
        idempotencyKey: key,
      }).expect(201);
      const replay = await redeem(t.token, t.customerId, {
        points: 30,
        idempotencyKey: key,
      }).expect(201);
      expect(replay.body.balancePoints).toBe(70); // spent once, not twice
    });

    it('serializes concurrent redemptions so neither drives the balance negative', async () => {
      const t = await newTenant();
      await adjust(t.token, t.customerId, {
        points: 100,
        reason: 'seed',
      }).expect(201);

      // Two tills try to spend the whole balance at once. The customer-row lock
      // lets exactly one win; the other sees a zero balance and is refused.
      const [a, b] = await Promise.all([
        redeem(t.token, t.customerId, { points: 100 }),
        redeem(t.token, t.customerId, { points: 100 }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 400]);

      const s = await t.summary().expect(200);
      expect(s.body.balancePoints).toBe(0); // never -100
    });
  });

  describe('refund reversal', () => {
    it("reverses a sale's points once, and may go negative if they were spent", async () => {
      const t = await newTenant();
      const order = await t.placeOrder();
      await earn(t.token, order.id).expect(201); // +10

      // Customer spends the earned points before the sale is refunded.
      await redeem(t.token, t.customerId, { points: 10 }).expect(201); // balance 0

      const reversed = await reverse(t.token, order.id).expect(201);
      expect(reversed.body.balancePoints).toBe(-10); // the honest, owed position

      // Reversing again is a no-op — the sale's points are unwound once.
      const again = await reverse(t.token, order.id).expect(201);
      expect(again.body.balancePoints).toBe(-10);
    });
  });

  describe('adjusting', () => {
    it('rejects a zero adjustment and a deduction below zero', async () => {
      const t = await newTenant();
      await adjust(t.token, t.customerId, { points: 0, reason: 'nope' }).expect(
        400,
      );
      await adjust(t.token, t.customerId, {
        points: -50,
        reason: 'too much',
      }).expect(400);
    });
  });

  describe('ledger integrity & events', () => {
    it('is append-only at the database and records an audit event per movement', async () => {
      const t = await newTenant();
      const order = await t.placeOrder();
      await earn(t.token, order.id).expect(201);

      // The audit log carries the loyalty event (owner bypasses RLS to read it).
      const events = await owner.auditLog.findMany({
        where: { restaurantId: t.restaurantId, action: 'loyalty.earned' },
        select: { entityType: true, entityId: true },
      });
      expect(events).toHaveLength(1);
      expect(events[0].entityType).toBe('customer');
      expect(events[0].entityId).toBe(t.customerId);

      // The trigger refuses an in-place edit of a ledger row — even for the owner.
      const row = await owner.loyaltyLedger.findFirst({
        where: { restaurantId: t.restaurantId },
        select: { id: true },
      });
      await expect(
        owner.$executeRawUnsafe(
          `UPDATE loyalty_ledger SET points = 0 WHERE id = '${row!.id}'`,
        ),
      ).rejects.toThrow();
    });
  });

  // M10 — Smart Checkout: earning/reversal now run automatically from the money
  // flow (create with full payment, the settling split leg, and refunds). No
  // manual earn/reverse endpoint is called in any test below.
  describe('smart checkout — automatic earn & reverse on settlement', () => {
    it('earns once when a full payment settles the order at placement', async () => {
      const t = await newTenant();
      await t.placeOrder({ paymentMethod: 'CASH' }); // net 10000 → 10 points

      const s = await t.summary().expect(200);
      expect(s.body.balancePoints).toBe(10);
      expect(s.body.lifetimeEarnedPoints).toBe(10);
      expect(
        s.body.recentEntries.filter((e: { type: string }) => e.type === 'EARN'),
      ).toHaveLength(1);
    });

    it('earns only when the final split leg settles the balance', async () => {
      const t = await newTenant();
      const order = await t.placeOrder(); // unpaid; total 10500

      // Partial leg — balance still owed, so nothing is earned yet.
      await pay(t.token, order.id, {
        method: 'CASH',
        amountMinor: 4000,
      }).expect(201);
      const mid = await t.summary().expect(200);
      expect(mid.body.balancePoints).toBe(0);

      // Settling leg — now fully paid, so it earns exactly once.
      await pay(t.token, order.id, {
        method: 'UPI',
        amountMinor: 6500,
      }).expect(201);
      const done = await t.summary().expect(200);
      expect(done.body.balancePoints).toBe(10);
      expect(
        done.body.recentEntries.filter(
          (e: { type: string }) => e.type === 'EARN',
        ),
      ).toHaveLength(1);
    });

    it('does not earn twice when the settling leg is replayed', async () => {
      const t = await newTenant();
      const order = await t.placeOrder();
      const key = randomUUID();

      await pay(t.token, order.id, {
        method: 'CASH',
        amountMinor: order.totalMinor,
        idempotencyKey: key,
      }).expect(201);
      await pay(t.token, order.id, {
        method: 'CASH',
        amountMinor: order.totalMinor,
        idempotencyKey: key,
      }).expect(201); // replay of the settling leg

      const s = await t.summary().expect(200);
      expect(s.body.balancePoints).toBe(10);
      expect(
        s.body.recentEntries.filter((e: { type: string }) => e.type === 'EARN'),
      ).toHaveLength(1);
    });

    it('does not earn for an anonymous (no-customer) sale', async () => {
      const t = await newTenant();
      const anon = await api()
        .post('/api/v1/orders')
        .set(auth(t.token))
        .send({
          items: [{ productId: await productId(t.token), quantity: 1 }],
          paymentMethod: 'CASH',
        })
        .expect(201);

      // No customer to credit; the ledger gains no EARN for this order.
      const rows = await owner.loyaltyLedger.findMany({
        where: { restaurantId: t.restaurantId, orderId: anon.body.id },
      });
      expect(rows).toHaveLength(0);
    });

    it('reverses all earned points on any refund, once, across repeated refunds', async () => {
      const t = await newTenant();
      const order = await t.placeOrder({ paymentMethod: 'CASH' }); // earns 10
      await setStatus(t.token, order.id, 'PREPARING').expect(200);
      await setStatus(t.token, order.id, 'READY').expect(200);
      await setStatus(t.token, order.id, 'COMPLETED').expect(200);

      // A partial refund reverses ALL earned points (M10: not proportional).
      await refund(t.token, order.id, {
        method: 'CASH',
        amountMinor: 4000,
        reason: 'Cold momos',
      }).expect(201);
      const afterFirst = await t.summary().expect(200);
      expect(afterFirst.body.balancePoints).toBe(0);
      expect(afterFirst.body.lifetimeEarnedPoints).toBe(0);
      expect(
        afterFirst.body.recentEntries.filter(
          (e: { type: string }) => e.type === 'REFUND_REVERSAL',
        ),
      ).toHaveLength(1);

      // A second refund within the refundable balance cannot reverse again.
      await refund(t.token, order.id, {
        method: 'CASH',
        amountMinor: 4000,
        reason: 'Also this',
      }).expect(201);
      const afterSecond = await t.summary().expect(200);
      expect(afterSecond.body.balancePoints).toBe(0);
      expect(
        afterSecond.body.recentEntries.filter(
          (e: { type: string }) => e.type === 'REFUND_REVERSAL',
        ),
      ).toHaveLength(1);
    });

    it('completes a refund even when the sale earned nothing (loyalty never blocks money)', async () => {
      const t = await newTenant();
      // Anonymous paid+completed order — no EARN exists, so the reversal is a
      // no-op the refund must swallow rather than fail on.
      const anon = await api()
        .post('/api/v1/orders')
        .set(auth(t.token))
        .send({
          items: [{ productId: await productId(t.token), quantity: 1 }],
          paymentMethod: 'CASH',
        })
        .expect(201);
      await setStatus(t.token, anon.body.id, 'PREPARING').expect(200);
      await setStatus(t.token, anon.body.id, 'READY').expect(200);
      await setStatus(t.token, anon.body.id, 'COMPLETED').expect(200);

      await refund(t.token, anon.body.id, {
        method: 'CASH',
        amountMinor: 100,
        reason: 'Goodwill',
      }).expect(201);
    });

    it('records the checkout earn on the tenant audit log (Timeline reads this)', async () => {
      const t = await newTenant();
      await t.placeOrder({ paymentMethod: 'CASH' });

      const events = await owner.auditLog.findMany({
        where: { restaurantId: t.restaurantId, action: 'loyalty.earned' },
        select: { entityId: true },
      });
      expect(events).toHaveLength(1);
      expect(events[0].entityId).toBe(t.customerId);
    });
  });

  // M11 — Loyalty Redemption: spend points as a server-computed discount at
  // checkout, atomic with the sale; restore them on refund. Rate 1 pt = ₹1.
  describe('loyalty redemption at checkout', () => {
    type Entry = { type: string; orderId: string | null; points: number };
    const seed = (t: Awaited<ReturnType<typeof newTenant>>, points: number) =>
      adjust(t.token, t.customerId, { points, reason: 'seed balance' });

    it('redeems points as a discount, atomically, once', async () => {
      const t = await newTenant();
      await seed(t, 500).expect(201);

      // Subtotal 10000; redeem 30 pts → ₹30 off = 3000 paise. total = 10000−3000+500.
      const order = await t.placeOrder({ redeemPoints: 30 });
      expect(order.discountMinor).toBe(3000);
      expect(order.totalMinor).toBe(7500);

      const s = await t.summary().expect(200);
      expect(s.body.balancePoints).toBe(470); // 500 − 30
      const redeems = (s.body.recentEntries as Entry[]).filter(
        (e) => e.type === 'REDEEM' && e.orderId === order.id,
      );
      expect(redeems).toHaveLength(1);
      expect(redeems[0].points).toBe(-30);
    });

    it('caps the redemption at the subtotal, never wasting points beyond it', async () => {
      const t = await newTenant();
      await seed(t, 500).expect(201);
      // Redeem 150 pts (₹150) on a ₹100 subtotal → capped to 100 pts (₹100 = subtotal).
      const order = await t.placeOrder({ redeemPoints: 150 });
      expect(order.discountMinor).toBe(10000); // subtotal, not 15000
      expect(order.totalMinor).toBe(500); // only tax remains
      const s = await t.summary().expect(200);
      expect(s.body.balancePoints).toBe(400); // 500 − 100 (only what fit)
    });

    it('cannot overspend the balance', async () => {
      const t = await newTenant();
      await seed(t, 30).expect(201);
      const pid = await productId(t.token);
      // 50 pts fits the subtotal (₹50 ≤ ₹100) but exceeds the 30 balance.
      await api()
        .post('/api/v1/orders')
        .set(auth(t.token))
        .send({
          items: [{ productId: pid, quantity: 1 }],
          customerId: t.customerId,
          redeemPoints: 50,
        })
        .expect(400);
      // Nothing spent — no order, no ledger movement.
      const s = await t.summary().expect(200);
      expect(s.body.balancePoints).toBe(30);
    });

    it('serializes concurrent redemptions so neither overspends', async () => {
      const t = await newTenant();
      await seed(t, 100).expect(201);
      const pid = await productId(t.token);
      const place = () =>
        api()
          .post('/api/v1/orders')
          .set(auth(t.token))
          .send({
            items: [{ productId: pid, quantity: 1 }],
            customerId: t.customerId,
            redeemPoints: 100,
          });
      const [a, b] = await Promise.all([place(), place()]);
      expect([a.status, b.status].sort()).toEqual([201, 400]);
      const s = await t.summary().expect(200);
      expect(s.body.balancePoints).toBe(0); // exactly one redemption of 100
    });

    it('refuses redemption without a customer, on a held order, or stacked with a discount', async () => {
      const t = await newTenant();
      await seed(t, 500).expect(201);
      const pid = await productId(t.token);
      const post = (body: Record<string, unknown>) =>
        api()
          .post('/api/v1/orders')
          .set(auth(t.token))
          .send({ items: [{ productId: pid, quantity: 1 }], ...body });

      await post({ redeemPoints: 30 }).expect(400); // no customer
      await post({
        customerId: t.customerId,
        redeemPoints: 30,
        hold: true,
      }).expect(400); // held order
      await post({
        customerId: t.customerId,
        redeemPoints: 30,
        manualDiscountMinor: 1000,
      }).expect(400); // stacked with a manual discount
    });

    it('earns on the discounted net, and a refund restores the redeemed points once', async () => {
      const t = await newTenant();
      await seed(t, 500).expect(201);
      // Redeem 30 (₹30 off) and pay in full → earns on net (10000−3000=7000 → 7 pts).
      const order = await t.placeOrder({
        redeemPoints: 30,
        paymentMethod: 'CASH',
      });
      const afterSale = await t.summary().expect(200);
      expect(afterSale.body.balancePoints).toBe(477); // 500 − 30 + 7
      const earns = (afterSale.body.recentEntries as Entry[]).filter(
        (e) => e.type === 'EARN',
      );
      expect(earns).toHaveLength(1);
      expect(earns[0].points).toBe(7); // earn on the discounted net
      const lifetimeBefore = afterSale.body.lifetimeEarnedPoints as number;

      await setStatus(t.token, order.id, 'PREPARING').expect(200);
      await setStatus(t.token, order.id, 'READY').expect(200);
      await setStatus(t.token, order.id, 'COMPLETED').expect(200);
      await refund(t.token, order.id, {
        method: 'CASH',
        amountMinor: 4000,
        reason: 'Complaint',
      }).expect(201);

      const afterRefund = await t.summary().expect(200);
      // 477 − 7 (earn reversed) + 30 (redeem restored) = 500 (back to the seed).
      expect(afterRefund.body.balancePoints).toBe(500);
      const restores = (afterRefund.body.recentEntries as Entry[]).filter(
        (e) => e.type === 'REDEEM_REVERSAL' && e.orderId === order.id,
      );
      expect(restores).toHaveLength(1);
      expect(restores[0].points).toBe(30);
      // The redeem/restore pair must NOT inflate the tier statistic — only the
      // earn walked back.
      expect(afterRefund.body.lifetimeEarnedPoints).toBe(lifetimeBefore - 7);

      // A second refund cannot double-restore.
      await refund(t.token, order.id, {
        method: 'CASH',
        amountMinor: 1000,
        reason: 'Again',
      }).expect(201);
      const afterSecond = await t.summary().expect(200);
      expect(afterSecond.body.balancePoints).toBe(500);
      expect(
        (afterSecond.body.recentEntries as Entry[]).filter(
          (e) => e.type === 'REDEEM_REVERSAL',
        ),
      ).toHaveLength(1);
    });

    it('records the redemption on the tenant audit log (Timeline/Analytics read this)', async () => {
      const t = await newTenant();
      await seed(t, 500).expect(201);
      await t.placeOrder({ redeemPoints: 30 });
      const events = await owner.auditLog.findMany({
        where: { restaurantId: t.restaurantId, action: 'loyalty.redeemed' },
        select: { entityId: true },
      });
      expect(events).toHaveLength(1);
      expect(events[0].entityId).toBe(t.customerId);
    });
  });
});

/** A product id for a tenant, for the anonymous-order case. */
async function productId(token: string): Promise<string> {
  const res = await api().get('/api/v1/products').set(auth(token)).expect(200);
  return res.body[0].id as string;
}
