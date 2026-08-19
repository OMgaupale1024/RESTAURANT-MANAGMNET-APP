/**
 * Configurable loyalty end-to-end (M13).
 *
 * The rules an owner sets must actually govern earning and redemption; a change
 * must NEVER rewrite history (each ledger row keeps the rule it was written
 * under); disabling stops earning/redeeming without touching balances; refunds
 * still reverse; a replay never double-credits; only owner/manager may configure;
 * and settings are tenant-isolated.
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

let ipCounter = 830000;
function api() {
  ipCounter++;
  const ip = `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
  const server = app.getHttpServer();
  return {
    post: (url: string) => request(server).post(url).set('X-Forwarded-For', ip),
    get: (url: string) => request(server).get(url).set('X-Forwarded-For', ip),
    put: (url: string) => request(server).put(url).set('X-Forwarded-For', ip),
  };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** The full settings body, with the spec's headline rates as the base. */
const settings = (over: Record<string, unknown> = {}) => ({
  isEnabled: true,
  earnAmountMinor: 10000, // ₹100
  earnPoints: 10,
  redeemPoints: 100,
  redeemAmountMinor: 5000, // ₹50
  minimumRedeemPoints: 100,
  maximumRedeemPointsPerOrder: 500,
  ...over,
});

async function newTenant() {
  const email = `loyset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
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
    // ₹100 + 5% GST → subtotal 10000, net 10000.
    .set(auth(token))
    .send({ name: 'Plate Momo', priceMinor: 10000, taxRateBp: 500 })
    .expect(201);

  const customer = await api()
    .post('/api/v1/customers')
    .set(auth(token))
    .send({ name: 'Asha', phone: `9${Date.now().toString().slice(-9)}` })
    .expect(201);

  const configure = (body: Record<string, unknown>) =>
    api().put('/api/v1/loyalty/settings').set(auth(token)).send(body);

  const getSettings = () =>
    api().get('/api/v1/loyalty/settings').set(auth(token));

  /** Places a paid, customer-attached order — which settles and earns. */
  const paidOrder = (opts: Record<string, unknown> = {}) =>
    api()
      .post('/api/v1/orders')
      .set(auth(token))
      .send({
        items: [{ productId: product.body.id, quantity: 1 }],
        customerId: customer.body.id,
        paymentMethod: 'CASH',
        ...opts,
      });

  const summary = () =>
    api().get(`/api/v1/customers/${customer.body.id}/loyalty`).set(auth(token));

  /** Grants points directly (manager adjust) so redemption tests have a balance. */
  const grant = (points: number) =>
    api()
      .post(`/api/v1/customers/${customer.body.id}/loyalty/adjust`)
      .set(auth(token))
      .send({ points, reason: 'seed' });

  return {
    email,
    token,
    restaurantId: created.body.restaurant.id as string,
    customerId: customer.body.id as string,
    productId: product.body.id as string,
    configure,
    getSettings,
    paidOrder,
    summary,
    grant,
  };
}

/** Demote/relabel the tenant owner to another role and return a fresh token. */
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

type Entry = {
  type: string;
  points: number;
  orderId: string | null;
  configSnapshot: Record<string, number> | null;
};

describe('Configurable loyalty (e2e)', () => {
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
      'loyalty_ledger',
      'refunds',
      'orders',
    ]) {
      await owner.$executeRawUnsafe(`ALTER TABLE ${tbl} DISABLE TRIGGER USER`);
    }
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 'loyset-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      const ids = ms.map((m) => m.restaurantId);
      await owner.loyaltySettings.deleteMany({
        where: { restaurantId: { in: ids } },
      });
      await owner.loyaltyLedger.deleteMany({
        where: { restaurantId: { in: ids } },
      });
      await owner.refund.deleteMany({ where: { restaurantId: { in: ids } } });
      await owner.order.deleteMany({ where: { restaurantId: { in: ids } } });
      await owner.customer.deleteMany({ where: { restaurantId: { in: ids } } });
      await owner.restaurant.deleteMany({ where: { id: { in: ids } } });
      await owner.securityEvent.deleteMany({
        where: { email: { startsWith: 'loyset-' } },
      });
      await owner.user.deleteMany({
        where: { email: { startsWith: 'loyset-' } },
      });
    } finally {
      for (const tbl of [
        'audit_logs',
        'order_events',
        'security_events',
        'loyalty_ledger',
        'refunds',
        'orders',
      ]) {
        await owner.$executeRawUnsafe(`ALTER TABLE ${tbl} ENABLE TRIGGER USER`);
      }
      await owner.$disconnect();
    }
    await app.close();
  });

  it('saves and reads back a configuration', async () => {
    const t = await newTenant();
    const saved = await t.configure(settings()).expect(200);
    expect(saved.body.earnPoints).toBe(10);
    expect(saved.body.redeemAmountMinor).toBe(5000);
    const got = await t.getSettings().expect(200);
    expect(got.body).toMatchObject(settings());
  });

  it('rejects an invalid configuration (absurd earn rate)', async () => {
    const t = await newTenant();
    await t
      .configure(settings({ earnAmountMinor: 100, earnPoints: 1_000_000 }))
      .expect(400);
  });

  it('earns at the configured rate on a paid order', async () => {
    const t = await newTenant();
    await t.configure(settings()).expect(200); // ₹100 → 10 points
    const order = await t.paidOrder().expect(201);
    const s = await t.summary().expect(200);
    // Net ₹100 → 10 points.
    expect(s.body.balancePoints).toBe(10);
    const earn = (s.body.recentEntries as Entry[]).find(
      (e) => e.type === 'EARN' && e.orderId === order.body.id,
    );
    expect(earn?.points).toBe(10);
    expect(earn?.configSnapshot).toEqual({
      earnAmountMinor: 10000,
      earnPoints: 10,
    });
  });

  it('redeems a configured block: 100 points → ₹50 off', async () => {
    const t = await newTenant();
    await t.configure(settings()).expect(200);
    await t.grant(140).expect(201);
    // Subtotal ₹100; redeem 100 pts → ₹50 off. total = 10000 − 5000 + 500.
    const order = await t.paidOrder({ redeemPoints: 100 }).expect(201);
    expect(order.body.discountMinor).toBe(5000);
    const s = await t.summary().expect(200);
    // 140 granted − 100 redeemed + 5 earned on the discounted net (5000 → 5).
    expect(s.body.balancePoints).toBe(45);
    const redeem = (s.body.recentEntries as Entry[]).find(
      (e) => e.type === 'REDEEM' && e.orderId === order.body.id,
    );
    expect(redeem?.points).toBe(-100);
    expect(redeem?.configSnapshot).toEqual({
      redeemPoints: 100,
      redeemAmountMinor: 5000,
    });
  });

  it('refuses redemption below the minimum, above the maximum, and off-block', async () => {
    const t = await newTenant();
    await t
      .configure(
        settings({
          minimumRedeemPoints: 100,
          maximumRedeemPointsPerOrder: 200,
        }),
      )
      .expect(200);
    await t.grant(1000).expect(201);
    await t.paidOrder({ redeemPoints: 50 }).expect(400); // below minimum
    await t.paidOrder({ redeemPoints: 300 }).expect(400); // above maximum
    await t.paidOrder({ redeemPoints: 137 }).expect(400); // not a whole block
  });

  it('keeps historical transactions explainable after the rule changes', async () => {
    const t = await newTenant();
    await t
      .configure(settings({ earnAmountMinor: 10000, earnPoints: 10 }))
      .expect(200);
    const order = await t.paidOrder().expect(201);

    // Change the rule to something less generous.
    await t
      .configure(settings({ earnAmountMinor: 10000, earnPoints: 5 }))
      .expect(200);

    const s = await t.summary().expect(200);
    const earn = (s.body.recentEntries as Entry[]).find(
      (e) => e.type === 'EARN' && e.orderId === order.body.id,
    );
    // Yesterday's transaction still shows yesterday's rule and points.
    expect(earn?.points).toBe(10);
    expect(earn?.configSnapshot).toEqual({
      earnAmountMinor: 10000,
      earnPoints: 10,
    });
  });

  it('reverses earned points when the order is refunded', async () => {
    const t = await newTenant();
    await t.configure(settings()).expect(200);
    const order = await t.paidOrder().expect(201);
    expect((await t.summary().expect(200)).body.balancePoints).toBe(10);

    await api()
      .post(`/api/v1/orders/${order.body.id}/refunds`)
      .set(auth(t.token))
      .send({
        idempotencyKey: randomUUID(),
        amountMinor: order.body.totalMinor,
        reason: 'test',
      })
      .expect(201);

    const s = await t.summary().expect(200);
    expect(s.body.balancePoints).toBe(0); // EARN +10, REFUND_REVERSAL −10
  });

  it('does not double-credit when earning is replayed for one order', async () => {
    const t = await newTenant();
    await t.configure(settings()).expect(200);
    const order = await t.paidOrder().expect(201); // earns 10 at placement
    // Explicit replay of the earn seam.
    await api()
      .post(`/api/v1/orders/${order.body.id}/loyalty/earn`)
      .set(auth(t.token))
      .expect(201);
    const s = await t.summary().expect(200);
    expect(s.body.balancePoints).toBe(10);
    expect(
      (s.body.recentEntries as Entry[]).filter((e) => e.type === 'EARN'),
    ).toHaveLength(1);
  });

  it('earns and redeems nothing while loyalty is disabled, preserving the balance', async () => {
    const t = await newTenant();
    await t.grant(200).expect(201); // balance exists first
    await t.configure(settings({ isEnabled: false })).expect(200);

    // A paid order earns nothing.
    await t.paidOrder().expect(201);
    let s = await t.summary().expect(200);
    expect(s.body.balancePoints).toBe(200); // unchanged — no earn
    expect(s.body.enabled).toBe(false);
    expect(s.body.availableReward).toBeNull();

    // Redemption is refused at the till and at the manual endpoint.
    await t.paidOrder({ redeemPoints: 100 }).expect(400);
    await api()
      .post(`/api/v1/customers/${t.customerId}/loyalty/redeem`)
      .set(auth(t.token))
      .send({ points: 100 })
      .expect(400);
    s = await t.summary().expect(200);
    expect(s.body.balancePoints).toBe(200); // still preserved
  });

  it('lets a cashier neither read nor change loyalty settings', async () => {
    const t = await newTenant();
    await t.configure(settings()).expect(200);
    const cashier = await becomeRole(t, 'CASHIER');
    await api().get('/api/v1/loyalty/settings').set(auth(cashier)).expect(403);
    await api()
      .put('/api/v1/loyalty/settings')
      .set(auth(cashier))
      .send(settings({ earnPoints: 99 }))
      .expect(403);
  });

  it('isolates settings between tenants', async () => {
    const a = await newTenant();
    const b = await newTenant();
    await a
      .configure(settings({ earnAmountMinor: 10000, earnPoints: 10 }))
      .expect(200);

    // B never configured: it sees the DEFAULT config, never A's values.
    const bSettings = await b.getSettings().expect(200);
    expect(bSettings.body.earnAmountMinor).toBe(1000); // default, not A's 10000
    expect(bSettings.body.earnPoints).toBe(1);
  });
});
