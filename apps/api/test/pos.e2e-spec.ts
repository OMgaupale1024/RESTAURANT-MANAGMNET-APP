/**
 * POS end-to-end, against the real database.
 *
 * The tests that matter: money integrity (the server prices, not the client)
 * and cross-tenant ordering.
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

let ipCounter = 200000;
function api() {
  ipCounter++;
  const ip = `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
  const server = app.getHttpServer();
  return {
    post: (url: string) => request(server).post(url).set('X-Forwarded-For', ip),
    get: (url: string) => request(server).get(url).set('X-Forwarded-For', ip),
  };
}

/** A user with a restaurant, holding a restaurant-scoped token. */
async function newTenant(name: string) {
  const email = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'POS Owner' })
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

  return {
    email,
    token: scoped.body.accessToken as string,
    restaurantId: created.body.restaurant.id as string,
  };
}

const makeProduct = (token: string, body: Record<string, unknown>) =>
  api()
    .post('/api/v1/products')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

describe('POS (e2e)', () => {
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
    // Orders cannot be deleted by the app role (backlog #6) and audit/event
    // tables are append-only. Teardown is the documented purge procedure.
    for (const t of ['audit_logs', 'order_events', 'security_events']) {
      await owner.$executeRawUnsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    }
    await owner.$executeRawUnsafe(`ALTER TABLE orders DISABLE TRIGGER USER`);
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 'p-' } },
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
        where: { email: { startsWith: 'p-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 'p-' } } });
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

  describe('catalogue', () => {
    it('creates and lists a product', async () => {
      const t = await newTenant('Menu Cafe');
      await makeProduct(t.token, {
        name: 'Veg Momo',
        priceMinor: 12000,
      }).expect(201);

      const res = await api()
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].priceMinor).toBe(12000);
      expect(res.body[0].taxRateBp).toBe(500); // 5% GST default
    });

    it("never shows another tenant's products", async () => {
      const a = await newTenant('Tenant A Cafe');
      const b = await newTenant('Tenant B Cafe');
      await makeProduct(a.token, {
        name: 'A Secret Dish',
        priceMinor: 100,
      }).expect(201);

      const res = await api()
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${b.token}`)
        .expect(200);
      expect(res.body).toHaveLength(0);
    });

    it('rejects a fractional price (paise are integers)', async () => {
      const t = await newTenant('Float Cafe');
      await makeProduct(t.token, { name: 'Bad', priceMinor: 12.5 }).expect(400);
    });

    it('rejects a negative price', async () => {
      const t = await newTenant('Negative Cafe');
      await makeProduct(t.token, { name: 'Bad', priceMinor: -100 }).expect(400);
    });

    it('rejects a duplicate product name', async () => {
      const t = await newTenant('Dup Cafe');
      await makeProduct(t.token, { name: 'Momo', priceMinor: 100 }).expect(201);
      await makeProduct(t.token, { name: 'Momo', priceMinor: 200 }).expect(409);
    });
  });

  describe('placing an order', () => {
    it('prices the order from the database and computes tax', async () => {
      const t = await newTenant('Order Cafe');
      const p = await makeProduct(t.token, {
        name: 'Paneer Momo',
        priceMinor: 15000, // ₹150.00
      }).expect(201);

      const res = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({
          items: [{ productId: p.body.id, quantity: 2 }],
          paymentMethod: 'CASH',
        })
        .expect(201);

      // 2 x 15000 = 30000 subtotal; 5% tax = 1500; total 31500
      expect(res.body.subtotalMinor).toBe(30000);
      expect(res.body.taxMinor).toBe(1500);
      expect(res.body.totalMinor).toBe(31500);
      expect(res.body.status).toBe('PLACED');
      expect(res.body.items[0].nameSnapshot).toBe('Paneer Momo');
      expect(res.body.payments[0].amountMinor).toBe(31500);
    });

    it('IGNORES a client-supplied price (the obvious POS attack)', async () => {
      const t = await newTenant('Attack Cafe');
      const p = await makeProduct(t.token, {
        name: 'Expensive Thali',
        priceMinor: 50000,
      }).expect(201);

      // Attacker tries to buy a ₹500 thali for ₹0.01.
      await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({
          items: [
            {
              productId: p.body.id,
              quantity: 1,
              unitPriceMinor: 1,
              priceMinor: 1,
            },
          ],
        })
        // forbidNonWhitelisted rejects the smuggled fields outright.
        .expect(400);

      // And with a clean payload the real price is charged regardless.
      const ok = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ productId: p.body.id, quantity: 1 }] })
        .expect(201);
      expect(ok.body.totalMinor).toBe(52500);
    });

    it("cannot order another tenant's product", async () => {
      const a = await newTenant('Victim Kitchen');
      const b = await newTenant('Attacker Kitchen');
      const victimProduct = await makeProduct(a.token, {
        name: 'Victim Dish',
        priceMinor: 9900,
      }).expect(201);

      // Valid token, someone else's product id.
      await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${b.token}`)
        .send({ items: [{ productId: victimProduct.body.id, quantity: 1 }] })
        .expect(400); // "unavailable" — existence is not confirmed
    });

    it('rejects an empty order', async () => {
      const t = await newTenant('Empty Cafe');
      await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [] })
        .expect(400);
    });

    it('rejects zero and negative quantities', async () => {
      const t = await newTenant('Qty Cafe');
      const p = await makeProduct(t.token, {
        name: 'Item',
        priceMinor: 100,
      }).expect(201);
      for (const quantity of [0, -3]) {
        await api()
          .post('/api/v1/orders')
          .set('Authorization', `Bearer ${t.token}`)
          .send({ items: [{ productId: p.body.id, quantity }] })
          .expect(400);
      }
    });

    it('numbers orders sequentially per restaurant, starting at 1', async () => {
      const a = await newTenant('Seq A');
      const b = await newTenant('Seq B');
      const pa = await makeProduct(a.token, {
        name: 'X',
        priceMinor: 100,
      }).expect(201);
      const pb = await makeProduct(b.token, {
        name: 'Y',
        priceMinor: 100,
      }).expect(201);

      const a1 = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ items: [{ productId: pa.body.id, quantity: 1 }] })
        .expect(201);
      const a2 = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ items: [{ productId: pa.body.id, quantity: 1 }] })
        .expect(201);
      const b1 = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${b.token}`)
        .send({ items: [{ productId: pb.body.id, quantity: 1 }] })
        .expect(201);

      expect(a1.body.orderNumber).toBe(1);
      expect(a2.body.orderNumber).toBe(2);
      // Each tenant has its own sequence — B does not continue A's.
      expect(b1.body.orderNumber).toBe(1);
    });

    it('is idempotent: a replayed key returns the same order', async () => {
      const t = await newTenant('Idem Cafe');
      const p = await makeProduct(t.token, {
        name: 'Z',
        priceMinor: 500,
      }).expect(201);
      const body = {
        items: [{ productId: p.body.id, quantity: 1 }],
        paymentMethod: 'CASH',
        idempotencyKey: `key-${Date.now()}`,
      };

      const first = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send(body)
        .expect(201);
      const second = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send(body)
        .expect(201);

      // Same order, not a double charge.
      expect(second.body.id).toBe(first.body.id);
      const orders = await owner.order.count({
        where: { restaurantId: t.restaurantId },
      });
      expect(orders).toBe(1);
    });

    it('writes an append-only CREATED event', async () => {
      const t = await newTenant('Event Cafe');
      const p = await makeProduct(t.token, {
        name: 'E',
        priceMinor: 100,
      }).expect(201);
      const o = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ productId: p.body.id, quantity: 1 }] })
        .expect(201);

      const events = await owner.orderEvent.findMany({
        where: { orderId: o.body.id },
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('CREATED');
      expect(events[0].toStatus).toBe('PLACED');
    });
  });

  describe('reading orders', () => {
    it("cannot read another tenant's order by id (IDOR)", async () => {
      const a = await newTenant('Read A');
      const b = await newTenant('Read B');
      const pa = await makeProduct(a.token, {
        name: 'A item',
        priceMinor: 100,
      }).expect(201);
      const order = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ items: [{ productId: pa.body.id, quantity: 1 }] })
        .expect(201);

      await api()
        .get(`/api/v1/orders/${order.body.id}`)
        .set('Authorization', `Bearer ${b.token}`)
        .expect(404); // not 403 — B must not learn the order exists
    });

    it('rejects a non-uuid order id', async () => {
      const t = await newTenant('Uuid Cafe');
      await api()
        .get('/api/v1/orders/not-a-uuid')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(400);
    });
  });

  describe('backlog #6: placed orders are financial records', () => {
    it('cannot be deleted by the app role', async () => {
      const t = await newTenant('Immutable Cafe');
      const p = await makeProduct(t.token, {
        name: 'D',
        priceMinor: 100,
      }).expect(201);
      const o = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ productId: p.body.id, quantity: 1 }] })
        .expect(201);

      // The app's own connection must be refused DELETE at the grant level.
      const appDb = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: process.env.DATABASE_URL_APP,
        }),
      });
      try {
        await expect(
          appDb.$transaction(async (db) => {
            await db.$executeRaw`SELECT set_config('app.restaurant_id', ${t.restaurantId}, true)`;
            return db.order.delete({ where: { id: o.body.id } });
          }),
        ).rejects.toThrow();
      } finally {
        await appDb.$disconnect();
      }
    });

    it('freezes totals once placed', async () => {
      const t = await newTenant('Freeze Cafe');
      const p = await makeProduct(t.token, {
        name: 'F',
        priceMinor: 10000,
      }).expect(201);
      const o = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ productId: p.body.id, quantity: 1 }] })
        .expect(201);

      const appDb = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: process.env.DATABASE_URL_APP,
        }),
      });
      try {
        // A cashier discounting their own theft after the fact.
        await expect(
          appDb.$transaction(async (db) => {
            await db.$executeRaw`SELECT set_config('app.restaurant_id', ${t.restaurantId}, true)`;
            return db.order.update({
              where: { id: o.body.id },
              data: { totalMinor: 1, subtotalMinor: 1, taxMinor: 0 },
            });
          }),
        ).rejects.toThrow(/immutable/i);
      } finally {
        await appDb.$disconnect();
      }
    });

    it('still allows a status transition (Orders/Kitchen need it)', async () => {
      const t = await newTenant('Status Cafe');
      const p = await makeProduct(t.token, {
        name: 'S',
        priceMinor: 100,
      }).expect(201);
      const o = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ productId: p.body.id, quantity: 1 }] })
        .expect(201);

      const appDb = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: process.env.DATABASE_URL_APP,
        }),
      });
      try {
        const updated = await appDb.$transaction(async (db) => {
          await db.$executeRaw`SELECT set_config('app.restaurant_id', ${t.restaurantId}, true)`;
          return db.order.update({
            where: { id: o.body.id },
            data: { status: 'PREPARING' },
          });
        });
        expect(updated.status).toBe('PREPARING');
      } finally {
        await appDb.$disconnect();
      }
    });
  });
});
