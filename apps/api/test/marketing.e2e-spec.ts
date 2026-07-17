/**
 * Marketing end-to-end.
 *
 * The tests that matter: a coupon discount is computed SERVER-SIDE (the client
 * sends only a code, never an amount), the deterministic rules (validity, min
 * order, max redemptions) are enforced, redemptions are append-only, segments
 * reuse the non-void rule, and nothing crosses a tenant boundary.
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

let ipCounter = 1000000;
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
  const email = `mk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'MK Owner' })
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
    .send({ name: 'Momo', priceMinor: 10000 }) // ₹100, tax 5% = ₹5
    .expect(201);
  return {
    email,
    token,
    restaurantId: created.body.restaurant.id as string,
    productId: product.body.id as string,
  };
}

const makeCoupon = (token: string, body: Record<string, unknown>) =>
  api()
    .post('/api/v1/marketing/coupons')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

const placeOrder = (token: string, body: Record<string, unknown>) =>
  api()
    .post('/api/v1/orders')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

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

describe('Marketing (e2e)', () => {
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
      'coupon_redemptions',
    ]) {
      await owner.$executeRawUnsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    }
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 'mk-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      const rids = ms.map((m) => m.restaurantId);
      await owner.couponRedemption.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.coupon.deleteMany({ where: { restaurantId: { in: rids } } });
      await owner.order.deleteMany({ where: { restaurantId: { in: rids } } });
      await owner.customer.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.restaurant.deleteMany({ where: { id: { in: rids } } });
      await owner.securityEvent.deleteMany({
        where: { email: { startsWith: 'mk-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 'mk-' } } });
    } finally {
      for (const t of [
        'audit_logs',
        'order_events',
        'security_events',
        'orders',
        'stock_movements',
        'coupon_redemptions',
      ]) {
        await owner.$executeRawUnsafe(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
      }
      await owner.$disconnect();
    }
    await app.close();
  });

  describe('coupon creation', () => {
    it('creates a percent coupon', async () => {
      const t = await newTenant('Coupon Cafe');
      const res = await makeCoupon(t.token, {
        code: 'save10',
        type: 'PERCENT',
        percentBp: 1000,
      }).expect(201);
      expect(res.body.code).toBe('SAVE10'); // uppercased
      expect(res.body.percentBp).toBe(1000);
    });

    it('rejects a PERCENT coupon with no percentBp', async () => {
      const t = await newTenant('Bad Percent Cafe');
      await makeCoupon(t.token, { code: 'BAD', type: 'PERCENT' }).expect(400);
    });

    it('rejects a percentBp over 100%', async () => {
      const t = await newTenant('Over Cafe');
      await makeCoupon(t.token, {
        code: 'OVER',
        type: 'PERCENT',
        percentBp: 20000,
      }).expect(400);
    });

    it('rejects a duplicate code in one tenant', async () => {
      const t = await newTenant('Dup Coupon Cafe');
      await makeCoupon(t.token, {
        code: 'DIWALI',
        type: 'FIXED',
        amountMinor: 5000,
      }).expect(201);
      await makeCoupon(t.token, {
        code: 'diwali',
        type: 'FIXED',
        amountMinor: 9999,
      }).expect(409);
    });

    it('lets two tenants each hold the same code', async () => {
      const a = await newTenant('Same Code A');
      const b = await newTenant('Same Code B');
      await makeCoupon(a.token, {
        code: 'DIWALI10',
        type: 'PERCENT',
        percentBp: 1000,
      }).expect(201);
      await makeCoupon(b.token, {
        code: 'DIWALI10',
        type: 'PERCENT',
        percentBp: 2000,
      }).expect(201);
    });
  });

  describe('redemption computes the discount server-side', () => {
    it('applies a percent discount and satisfies the money identity', async () => {
      const t = await newTenant('Redeem Percent Cafe');
      await makeCoupon(t.token, {
        code: 'TEN',
        type: 'PERCENT',
        percentBp: 1000,
      }).expect(201);

      // 2 x ₹100 = ₹200 subtotal, tax 5% = ₹10. 10% off subtotal = ₹20.
      // total = 20000 - 2000 + 1000 = 19000.
      const res = await placeOrder(t.token, {
        items: [{ productId: t.productId, quantity: 2 }],
        couponCode: 'TEN',
      }).expect(201);

      expect(res.body.subtotalMinor).toBe(20000);
      expect(res.body.discountMinor).toBe(2000);
      expect(res.body.taxMinor).toBe(1000);
      expect(res.body.totalMinor).toBe(19000);
    });

    it('applies a fixed discount', async () => {
      const t = await newTenant('Redeem Fixed Cafe');
      await makeCoupon(t.token, {
        code: 'FLAT50',
        type: 'FIXED',
        amountMinor: 5000,
      }).expect(201);

      const res = await placeOrder(t.token, {
        items: [{ productId: t.productId, quantity: 2 }], // 20000 subtotal
        couponCode: 'FLAT50',
      }).expect(201);
      expect(res.body.discountMinor).toBe(5000);
      expect(res.body.totalMinor).toBe(16000); // 20000 - 5000 + 1000
    });

    it('IGNORES a client-supplied discount amount (the obvious attack)', async () => {
      const t = await newTenant('Attack Discount Cafe');
      await makeCoupon(t.token, {
        code: 'TEN',
        type: 'PERCENT',
        percentBp: 1000,
      }).expect(201);
      // Smuggling discountMinor must be rejected by forbidNonWhitelisted.
      await placeOrder(t.token, {
        items: [{ productId: t.productId, quantity: 1 }],
        couponCode: 'TEN',
        discountMinor: 9999,
      }).expect(400);
    });

    it('caps a percent discount at maxDiscountMinor', async () => {
      const t = await newTenant('Cap Cafe');
      await makeCoupon(t.token, {
        code: 'BIG',
        type: 'PERCENT',
        percentBp: 5000, // 50%
        maxDiscountMinor: 3000, // but never more than ₹30
      }).expect(201);

      const res = await placeOrder(t.token, {
        items: [{ productId: t.productId, quantity: 2 }], // 20000, 50% = 10000
        couponCode: 'BIG',
      }).expect(201);
      expect(res.body.discountMinor).toBe(3000); // capped
    });

    it('rejects an order below the minimum subtotal', async () => {
      const t = await newTenant('Min Cafe');
      await makeCoupon(t.token, {
        code: 'MIN500',
        type: 'FIXED',
        amountMinor: 5000,
        minSubtotalMinor: 50000, // needs ₹500
      }).expect(201);
      await placeOrder(t.token, {
        items: [{ productId: t.productId, quantity: 1 }], // only ₹100
        couponCode: 'MIN500',
      }).expect(400);
    });

    it('rejects an expired coupon', async () => {
      const t = await newTenant('Expired Coupon Cafe');
      const c = await makeCoupon(t.token, {
        code: 'OLD',
        type: 'FIXED',
        amountMinor: 5000,
      }).expect(201);
      await owner.coupon.update({
        where: { id: c.body.id },
        data: {
          validFrom: new Date(Date.now() - 2 * 86400000),
          validUntil: new Date(Date.now() - 86400000),
        },
      });
      await placeOrder(t.token, {
        items: [{ productId: t.productId, quantity: 1 }],
        couponCode: 'OLD',
      }).expect(400);
    });

    it('rejects an inactive coupon', async () => {
      const t = await newTenant('Inactive Cafe');
      const c = await makeCoupon(t.token, {
        code: 'OFF',
        type: 'FIXED',
        amountMinor: 5000,
      }).expect(201);
      await api()
        .patch(`/api/v1/marketing/coupons/${c.body.id}`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ isActive: false })
        .expect(200);
      await placeOrder(t.token, {
        items: [{ productId: t.productId, quantity: 1 }],
        couponCode: 'OFF',
      }).expect(400);
    });

    it('rejects an unknown code', async () => {
      const t = await newTenant('Unknown Coupon Cafe');
      await placeOrder(t.token, {
        items: [{ productId: t.productId, quantity: 1 }],
        couponCode: 'NOPE',
      }).expect(400);
    });

    it('enforces max redemptions', async () => {
      const t = await newTenant('Max Redeem Cafe');
      await makeCoupon(t.token, {
        code: 'ONCE',
        type: 'FIXED',
        amountMinor: 1000,
        maxRedemptions: 1,
      }).expect(201);

      await placeOrder(t.token, {
        items: [{ productId: t.productId, quantity: 1 }],
        couponCode: 'ONCE',
      }).expect(201);
      // The second use must be refused.
      await placeOrder(t.token, {
        items: [{ productId: t.productId, quantity: 1 }],
        couponCode: 'ONCE',
      }).expect(400);
    });

    it('records the redemption append-only', async () => {
      const t = await newTenant('Append Redeem Cafe');
      await makeCoupon(t.token, {
        code: 'TRACK',
        type: 'FIXED',
        amountMinor: 2000,
      }).expect(201);
      const order = await placeOrder(t.token, {
        items: [{ productId: t.productId, quantity: 1 }],
        couponCode: 'TRACK',
      }).expect(201);

      const redemption = await owner.couponRedemption.findFirst({
        where: { orderId: order.body.id },
      });
      expect(redemption).toBeTruthy();
      expect(redemption!.discountMinor).toBe(2000);

      // The app role must not be able to rewrite the discount that was given.
      const appDb = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: process.env.DATABASE_URL_APP,
        }),
      });
      try {
        await expect(
          appDb.$transaction(async (db) => {
            await db.$executeRaw`SELECT set_config('app.restaurant_id', ${t.restaurantId}, true)`;
            return db.couponRedemption.deleteMany({
              where: { orderId: order.body.id },
            });
          }),
        ).rejects.toThrow();
      } finally {
        await appDb.$disconnect();
      }
    });
  });

  describe('segments (deterministic)', () => {
    it('returns segment counts with their rules and a recommendation', async () => {
      const t = await newTenant('Segment Cafe');
      const res = await api()
        .get('/api/v1/marketing/segments')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      // Rules are stated, never a black box.
      expect(
        res.body.segments.map((s: { key: string }) => s.key).sort(),
      ).toEqual(['LAPSED', 'NEW', 'REGULAR', 'VIP']);
      for (const s of res.body.segments) expect(typeof s.rule).toBe('string');
    });

    it('classifies a repeat customer as REGULAR', async () => {
      const t = await newTenant('Regular Segment Cafe');
      const cust = await api()
        .post('/api/v1/customers')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ name: 'Repeat Riya', phone: '9800000001' })
        .expect(201);
      // Three visits => REGULAR by rule.
      for (let i = 0; i < 3; i++) {
        await placeOrder(t.token, {
          items: [{ productId: t.productId, quantity: 1 }],
          customerId: cust.body.id,
        }).expect(201);
      }
      const list = await api()
        .get('/api/v1/marketing/segments/REGULAR/customers')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      expect(list.body.some((c: { id: string }) => c.id === cust.body.id)).toBe(
        true,
      );
    });

    it('rejects an unknown segment key', async () => {
      const t = await newTenant('Bad Segment Cafe');
      await api()
        .get('/api/v1/marketing/segments/ROYALTY/customers')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(400);
    });
  });

  describe('permissions and isolation', () => {
    it('a CASHIER cannot create coupons', async () => {
      const t = await newTenant('Cashier Coupon Cafe');
      const cashier = await becomeRole(t, 'CASHIER');
      await makeCoupon(cashier, {
        code: 'X',
        type: 'FIXED',
        amountMinor: 1000,
      }).expect(403);
    });

    it("cannot redeem another tenant's coupon", async () => {
      const a = await newTenant('Coupon Iso A');
      const b = await newTenant('Coupon Iso B');
      await makeCoupon(a.token, {
        code: 'ASECRET',
        type: 'FIXED',
        amountMinor: 5000,
      }).expect(201);
      // B tries A's code — RLS makes it not exist for B.
      await placeOrder(b.token, {
        items: [{ productId: b.productId, quantity: 1 }],
        couponCode: 'ASECRET',
      }).expect(400);
    });

    it("never lists another tenant's coupons", async () => {
      const a = await newTenant('List Iso A');
      const b = await newTenant('List Iso B');
      await makeCoupon(a.token, {
        code: 'AONLY',
        type: 'FIXED',
        amountMinor: 1000,
      }).expect(201);
      const res = await api()
        .get('/api/v1/marketing/coupons')
        .set('Authorization', `Bearer ${b.token}`)
        .expect(200);
      expect(res.body).toHaveLength(0);
    });
  });
});
