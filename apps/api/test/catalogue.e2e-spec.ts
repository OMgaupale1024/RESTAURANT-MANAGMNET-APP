/**
 * Menu management end-to-end, against the real database.
 *
 * What matters here: edits stay tenant-scoped, deactivation actually stops a
 * sale, and a category delete never takes products down with it.
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
    put: (url: string) => request(server).put(url).set('X-Forwarded-For', ip),
    patch: (url: string) =>
      request(server).patch(url).set('X-Forwarded-For', ip),
    delete: (url: string) =>
      request(server).delete(url).set('X-Forwarded-For', ip),
  };
}

/** A user with a restaurant, holding a restaurant-scoped token. */
async function newTenant(name: string) {
  const email = `cat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Menu Owner' })
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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('Catalogue management (e2e)', () => {
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
    for (const t of ['audit_logs', 'order_events', 'security_events']) {
      await owner.$executeRawUnsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    }
    await owner.$executeRawUnsafe(`ALTER TABLE orders DISABLE TRIGGER USER`);
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 'cat-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      const restaurantIds = ms.map((m) => m.restaurantId);
      // products/categories carry no FK to restaurants — clear them explicitly.
      await owner.product.deleteMany({
        where: { restaurantId: { in: restaurantIds } },
      });
      await owner.category.deleteMany({
        where: { restaurantId: { in: restaurantIds } },
      });
      await owner.restaurant.deleteMany({
        where: { id: { in: restaurantIds } },
      });
      await owner.securityEvent.deleteMany({
        where: { email: { startsWith: 'cat-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 'cat-' } } });
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

  describe('product edit', () => {
    it('updates name, price, tax and category', async () => {
      const t = await newTenant('Edit Cafe');
      const cat = await api()
        .post('/api/v1/categories')
        .set(auth(t.token))
        .send({ name: 'Momos' })
        .expect(201);
      const p = await api()
        .post('/api/v1/products')
        .set(auth(t.token))
        .send({ name: 'Veg Momo', priceMinor: 12000 })
        .expect(201);

      const upd = await api()
        .patch(`/api/v1/products/${p.body.id}`)
        .set(auth(t.token))
        .send({
          name: 'Veg Momo (8pc)',
          priceMinor: 14000,
          taxRateBp: 1200,
          categoryId: cat.body.id,
        })
        .expect(200);
      expect(upd.body).toMatchObject({
        name: 'Veg Momo (8pc)',
        priceMinor: 14000,
        taxRateBp: 1200,
        categoryId: cat.body.id,
        isActive: true,
      });

      // categoryId: null moves it back to uncategorised.
      const cleared = await api()
        .patch(`/api/v1/products/${p.body.id}`)
        .set(auth(t.token))
        .send({ categoryId: null })
        .expect(200);
      expect(cleared.body.categoryId).toBeNull();
    });

    it('rejects a rename onto an existing product name', async () => {
      const t = await newTenant('Conflict Cafe');
      await api()
        .post('/api/v1/products')
        .set(auth(t.token))
        .send({ name: 'Thukpa', priceMinor: 9000 })
        .expect(201);
      const p2 = await api()
        .post('/api/v1/products')
        .set(auth(t.token))
        .send({ name: 'Chowmein', priceMinor: 8000 })
        .expect(201);

      await api()
        .patch(`/api/v1/products/${p2.body.id}`)
        .set(auth(t.token))
        .send({ name: 'Thukpa' })
        .expect(409);
    });

    it('rejects a category from another tenant', async () => {
      const a = await newTenant('Cat Owner A');
      const b = await newTenant('Cat Owner B');
      const catB = await api()
        .post('/api/v1/categories')
        .set(auth(b.token))
        .send({ name: 'B Only' })
        .expect(201);
      const p = await api()
        .post('/api/v1/products')
        .set(auth(a.token))
        .send({ name: 'A Dish', priceMinor: 5000 })
        .expect(201);

      await api()
        .patch(`/api/v1/products/${p.body.id}`)
        .set(auth(a.token))
        .send({ categoryId: catB.body.id })
        .expect(400);
    });

    it("cannot edit another tenant's product (same 404 as unknown id)", async () => {
      const a = await newTenant('Victim Cafe');
      const b = await newTenant('Attacker Cafe');
      const p = await api()
        .post('/api/v1/products')
        .set(auth(a.token))
        .send({ name: 'Secret Special', priceMinor: 10000 })
        .expect(201);

      await api()
        .patch(`/api/v1/products/${p.body.id}`)
        .set(auth(b.token))
        .send({ priceMinor: 1 })
        .expect(404);

      // Unchanged for the owner.
      const list = await api()
        .get('/api/v1/products')
        .set(auth(a.token))
        .expect(200);
      expect(list.body[0].priceMinor).toBe(10000);
    });
  });

  describe('deactivation', () => {
    it('hides the product from the default list but keeps it in ?include=all', async () => {
      const t = await newTenant('Hide Cafe');
      const p = await api()
        .post('/api/v1/products')
        .set(auth(t.token))
        .send({ name: 'Seasonal Dish', priceMinor: 15000 })
        .expect(201);

      await api()
        .patch(`/api/v1/products/${p.body.id}`)
        .set(auth(t.token))
        .send({ isActive: false })
        .expect(200);

      const active = await api()
        .get('/api/v1/products')
        .set(auth(t.token))
        .expect(200);
      expect(active.body).toHaveLength(0);

      const all = await api()
        .get('/api/v1/products?include=all')
        .set(auth(t.token))
        .expect(200);
      expect(all.body).toHaveLength(1);
      expect(all.body[0].isActive).toBe(false);
    });

    it('a deactivated product cannot be sold, and can after reactivation', async () => {
      const t = await newTenant('Sellable Cafe');
      const p = await api()
        .post('/api/v1/products')
        .set(auth(t.token))
        .send({ name: 'Paneer Momo', priceMinor: 16000 })
        .expect(201);

      await api()
        .patch(`/api/v1/products/${p.body.id}`)
        .set(auth(t.token))
        .send({ isActive: false })
        .expect(200);

      await api()
        .post('/api/v1/orders')
        .set(auth(t.token))
        .send({ items: [{ productId: p.body.id, quantity: 1 }] })
        .expect(400);

      await api()
        .patch(`/api/v1/products/${p.body.id}`)
        .set(auth(t.token))
        .send({ isActive: true })
        .expect(200);

      const order = await api()
        .post('/api/v1/orders')
        .set(auth(t.token))
        .send({ items: [{ productId: p.body.id, quantity: 1 }] })
        .expect(201);
      expect(order.body.totalMinor).toBeGreaterThan(0);
    });
  });

  describe('categories', () => {
    it('renames a category', async () => {
      const t = await newTenant('Rename Cafe');
      const c = await api()
        .post('/api/v1/categories')
        .set(auth(t.token))
        .send({ name: 'Startres' })
        .expect(201);

      const upd = await api()
        .patch(`/api/v1/categories/${c.body.id}`)
        .set(auth(t.token))
        .send({ name: 'Starters' })
        .expect(200);
      expect(upd.body.name).toBe('Starters');
    });

    it('reorders categories atomically and rejects a partial list', async () => {
      const t = await newTenant('Order Cafe');
      const names = ['Momos', 'Noodles', 'Drinks'];
      const ids: string[] = [];
      for (const name of names) {
        const c = await api()
          .post('/api/v1/categories')
          .set(auth(t.token))
          .send({ name })
          .expect(201);
        ids.push(c.body.id);
      }

      const reordered = await api()
        .put('/api/v1/categories/order')
        .set(auth(t.token))
        .send({ ids: [ids[2], ids[0], ids[1]] })
        .expect(200);
      expect(reordered.body.map((c: { name: string }) => c.name)).toEqual([
        'Drinks',
        'Momos',
        'Noodles',
      ]);

      await api()
        .put('/api/v1/categories/order')
        .set(auth(t.token))
        .send({ ids: [ids[0]] })
        .expect(400);
    });

    it('deleting a category keeps its products, uncategorised', async () => {
      const t = await newTenant('Delete Cafe');
      const c = await api()
        .post('/api/v1/categories')
        .set(auth(t.token))
        .send({ name: 'Doomed' })
        .expect(201);
      const p = await api()
        .post('/api/v1/products')
        .set(auth(t.token))
        .send({
          name: 'Survivor Dish',
          priceMinor: 7000,
          categoryId: c.body.id,
        })
        .expect(201);
      expect(p.body.categoryId).toBe(c.body.id);

      await api()
        .delete(`/api/v1/categories/${c.body.id}`)
        .set(auth(t.token))
        .expect(200);

      const list = await api()
        .get('/api/v1/products')
        .set(auth(t.token))
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].categoryId).toBeNull();
    });

    it("cannot delete another tenant's category", async () => {
      const a = await newTenant('Del Victim');
      const b = await newTenant('Del Attacker');
      const c = await api()
        .post('/api/v1/categories')
        .set(auth(a.token))
        .send({ name: 'Mine' })
        .expect(201);

      await api()
        .delete(`/api/v1/categories/${c.body.id}`)
        .set(auth(b.token))
        .expect(404);

      const list = await api()
        .get('/api/v1/categories')
        .set(auth(a.token))
        .expect(200);
      expect(list.body).toHaveLength(1);
    });
  });
});
