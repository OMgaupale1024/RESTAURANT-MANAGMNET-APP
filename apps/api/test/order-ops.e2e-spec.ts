/**
 * Order operations end-to-end: hold/park, resume, order types, per-item
 * notes, keyset pagination.
 *
 * The correctness that matters: a held order takes no money and depletes no
 * stock; resuming it is the moment both happen.
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
    put: (url: string) => request(server).put(url).set('X-Forwarded-For', ip),
  };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function newTenant() {
  const email = `oop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Ops Owner' })
    .expect(201);
  const cookie = reg.headers['set-cookie'][0].split(';')[0];
  const created = await api()
    .post('/api/v1/restaurants')
    .set(auth(reg.body.accessToken))
    .send({ name: `Ops Cafe ${Date.now()}` })
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
    .send({ name: 'Recipe Momo', priceMinor: 10000, taxRateBp: 500 })
    .expect(201);

  return { token, productId: product.body.id as string };
}

/** Attaches a one-ingredient recipe (100g flour per unit) and stocks 1000g. */
async function withRecipe(t: { token: string; productId: string }) {
  const ing = await api()
    .post('/api/v1/ingredients')
    .set(auth(t.token))
    .send({ name: 'Flour', unit: 'GRAM' })
    .expect(201);
  await api()
    .post(`/api/v1/ingredients/${ing.body.id}/movements`)
    .set(auth(t.token))
    .send({ type: 'PURCHASE', quantity: 1000, idempotencyKey: randomUUID() })
    .expect(201);
  await api()
    .put(`/api/v1/products/${t.productId}/recipe`)
    .set(auth(t.token))
    .send({ items: [{ ingredientId: ing.body.id, quantity: 100 }] })
    .expect(200);
  return ing.body.id as string;
}

const stockOf = async (token: string, ingredientId: string) => {
  const res = await api()
    .get(`/api/v1/ingredients/${ingredientId}`)
    .set(auth(token))
    .expect(200);
  return res.body.currentStock as number;
};

describe('Order operations (e2e)', () => {
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
    for (const tbl of ['audit_logs', 'order_events', 'security_events']) {
      await owner.$executeRawUnsafe(`ALTER TABLE ${tbl} DISABLE TRIGGER USER`);
    }
    await owner.$executeRawUnsafe(`ALTER TABLE orders DISABLE TRIGGER USER`);
    await owner.$executeRawUnsafe(
      `ALTER TABLE stock_movements DISABLE TRIGGER USER`,
    );
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 'oop-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      const ids = ms.map((m) => m.restaurantId);
      await owner.stockMovement.deleteMany({ where: { restaurantId: { in: ids } } });
      await owner.recipeItem.deleteMany({ where: { restaurantId: { in: ids } } });
      await owner.ingredient.deleteMany({ where: { restaurantId: { in: ids } } });
      await owner.product.deleteMany({ where: { restaurantId: { in: ids } } });
      await owner.restaurant.deleteMany({ where: { id: { in: ids } } });
      await owner.securityEvent.deleteMany({
        where: { email: { startsWith: 'oop-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 'oop-' } } });
    } finally {
      for (const tbl of [
        'audit_logs',
        'order_events',
        'security_events',
        'orders',
        'stock_movements',
      ]) {
        await owner.$executeRawUnsafe(`ALTER TABLE ${tbl} ENABLE TRIGGER USER`);
      }
      await owner.$disconnect();
    }
    await app.close();
  });

  describe('hold and resume', () => {
    it('a held order is a DRAFT with no payment and no stock movement', async () => {
      const t = await newTenant();
      const ingId = await withRecipe(t);

      const held = await api()
        .post('/api/v1/orders')
        .set(auth(t.token))
        .send({
          items: [{ productId: t.productId, quantity: 3 }],
          hold: true,
          idempotencyKey: randomUUID(),
        })
        .expect(201);
      expect(held.body.status).toBe('DRAFT');
      expect(held.body.placedAt).toBeNull();
      expect(held.body.payments).toHaveLength(0);

      // Stock is untouched — the food has not been cooked.
      expect(await stockOf(t.token, ingId)).toBe(1000);

      // It is reachable by the DRAFT filter (the POS held tray).
      const drafts = await api()
        .get('/api/v1/orders?status=DRAFT')
        .set(auth(t.token))
        .expect(200);
      expect(drafts.body.map((o: { id: string }) => o.id)).toContain(held.body.id);
    });

    it('a held order cannot carry a payment', async () => {
      const t = await newTenant();
      await api()
        .post('/api/v1/orders')
        .set(auth(t.token))
        .send({
          items: [{ productId: t.productId, quantity: 1 }],
          hold: true,
          paymentMethod: 'CASH',
          idempotencyKey: randomUUID(),
        })
        .expect(400);
    });

    it('resuming a held order places it, stamps placedAt and depletes stock', async () => {
      const t = await newTenant();
      const ingId = await withRecipe(t);

      const held = await api()
        .post('/api/v1/orders')
        .set(auth(t.token))
        .send({
          items: [{ productId: t.productId, quantity: 4 }],
          hold: true,
          idempotencyKey: randomUUID(),
        })
        .expect(201);
      expect(await stockOf(t.token, ingId)).toBe(1000);

      const resumed = await api()
        .patch(`/api/v1/orders/${held.body.id}/status`)
        .set(auth(t.token))
        .send({ status: 'PLACED' })
        .expect(200);
      expect(resumed.body.status).toBe('PLACED');
      expect(resumed.body.placedAt).not.toBeNull();

      // 4 units × 100g = 400g gone, now that it is actually placed.
      expect(await stockOf(t.token, ingId)).toBe(600);

      // It can now take payment like any placed order.
      await api()
        .post(`/api/v1/orders/${held.body.id}/payments`)
        .set(auth(t.token))
        .send({
          method: 'CASH',
          amountMinor: resumed.body.totalMinor,
          idempotencyKey: randomUUID(),
        })
        .expect(201);
    });
  });

  describe('order types and per-item notes', () => {
    it('defaults to TAKEAWAY and stores the chosen type', async () => {
      const t = await newTenant();
      const def = await api()
        .post('/api/v1/orders')
        .set(auth(t.token))
        .send({
          items: [{ productId: t.productId, quantity: 1 }],
          idempotencyKey: randomUUID(),
        })
        .expect(201);
      expect(def.body.orderType).toBe('TAKEAWAY');

      const dineIn = await api()
        .post('/api/v1/orders')
        .set(auth(t.token))
        .send({
          items: [{ productId: t.productId, quantity: 1 }],
          orderType: 'DINE_IN',
          idempotencyKey: randomUUID(),
        })
        .expect(201);
      expect(dineIn.body.orderType).toBe('DINE_IN');
    });

    it('rejects an unknown order type', async () => {
      const t = await newTenant();
      await api()
        .post('/api/v1/orders')
        .set(auth(t.token))
        .send({
          items: [{ productId: t.productId, quantity: 1 }],
          orderType: 'DRIVE_THRU',
          idempotencyKey: randomUUID(),
        })
        .expect(400);
    });

    it('stores per-item notes', async () => {
      const t = await newTenant();
      const order = await api()
        .post('/api/v1/orders')
        .set(auth(t.token))
        .send({
          items: [
            { productId: t.productId, quantity: 2, notes: 'no onion, extra spicy' },
          ],
          idempotencyKey: randomUUID(),
        })
        .expect(201);
      expect(order.body.items[0].notes).toBe('no onion, extra spicy');
    });
  });

  describe('pagination', () => {
    it('pages by cursor without gaps or overlaps', async () => {
      const t = await newTenant();
      // 5 orders; page size 2.
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        const o = await api()
          .post('/api/v1/orders')
          .set(auth(t.token))
          .send({
            items: [{ productId: t.productId, quantity: 1 }],
            idempotencyKey: randomUUID(),
          })
          .expect(201);
        created.push(o.body.id);
      }

      const page1 = await api()
        .get('/api/v1/orders?limit=2')
        .set(auth(t.token))
        .expect(200);
      expect(page1.body).toHaveLength(2);

      const cursor = page1.body[page1.body.length - 1].id;
      const page2 = await api()
        .get(`/api/v1/orders?limit=2&cursor=${cursor}`)
        .set(auth(t.token))
        .expect(200);
      expect(page2.body).toHaveLength(2);

      // Newest-first, and the two pages are disjoint.
      const p1ids = page1.body.map((o: { id: string }) => o.id);
      const p2ids = page2.body.map((o: { id: string }) => o.id);
      expect(p1ids.every((id: string) => !p2ids.includes(id))).toBe(true);
      // page2 ids are all older (lexicographically smaller UUIDv7) than cursor.
      expect(p2ids.every((id: string) => id < cursor)).toBe(true);
    });
  });
});
