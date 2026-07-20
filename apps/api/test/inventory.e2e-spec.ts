/**
 * Inventory end-to-end.
 *
 * The tests that matter: the ledger is the truth (stock is a sum, never a
 * column), depletion is automatic and transactional, and a client cannot
 * manufacture a CONSUMPTION.
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

let ipCounter = 500000;
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
  };
}

async function newTenant(name: string) {
  const email = `i-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Inv Owner' })
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
    .send({ name: 'Veg Momo', priceMinor: 10000 })
    .expect(201);

  return {
    email,
    token,
    restaurantId: created.body.restaurant.id as string,
    productId: product.body.id as string,
  };
}

const addIngredient = (token: string, body: Record<string, unknown>) =>
  api()
    .post('/api/v1/ingredients')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

const move = (token: string, id: string, body: Record<string, unknown>) =>
  api()
    .post(`/api/v1/ingredients/${id}/movements`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

const getIngredient = (token: string, id: string) =>
  api()
    .get(`/api/v1/ingredients/${id}`)
    .set('Authorization', `Bearer ${token}`);

describe('Inventory (e2e)', () => {
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
        where: { email: { startsWith: 'i-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      const rids = ms.map((m) => m.restaurantId);
      // Restrict FKs mean order matters: movements/recipes before ingredients.
      await owner.stockMovement.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.recipeItem.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.ingredient.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.order.deleteMany({ where: { restaurantId: { in: rids } } });
      await owner.customer.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.restaurant.deleteMany({ where: { id: { in: rids } } });
      await owner.securityEvent.deleteMany({
        where: { email: { startsWith: 'i-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 'i-' } } });
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

  describe('the ledger is the truth', () => {
    it('starts an ingredient at zero with no movements', async () => {
      const t = await newTenant('Ledger Cafe');
      const ing = await addIngredient(t.token, {
        name: 'Paneer',
        unit: 'GRAM',
      }).expect(201);

      const res = await getIngredient(t.token, ing.body.id).expect(200);
      expect(res.body.currentStock).toBe(0);
      expect(res.body.movements).toHaveLength(0);
    });

    it('computes stock as the sum of movements', async () => {
      const t = await newTenant('Sum Cafe');
      const ing = await addIngredient(t.token, {
        name: 'Flour',
        unit: 'GRAM',
      }).expect(201);

      await move(t.token, ing.body.id, {
        type: 'PURCHASE',
        quantity: 10000,
      }).expect(201);
      await move(t.token, ing.body.id, {
        type: 'PURCHASE',
        quantity: 5000,
      }).expect(201);
      await move(t.token, ing.body.id, {
        type: 'WASTE',
        quantity: 2000,
      }).expect(201);

      const res = await getIngredient(t.token, ing.body.id).expect(200);
      // 10000 + 5000 - 2000
      expect(res.body.currentStock).toBe(13000);
      expect(res.body.movements).toHaveLength(3);
    });

    it('applies the sign from the type, not from the client', async () => {
      const t = await newTenant('Sign Cafe');
      const ing = await addIngredient(t.token, {
        name: 'Cheese',
        unit: 'GRAM',
      }).expect(201);

      // A client sending a negative "PURCHASE" must not remove stock.
      await move(t.token, ing.body.id, {
        type: 'PURCHASE',
        quantity: -5000,
      }).expect(400);

      // And a WASTE always subtracts, however it is phrased.
      await move(t.token, ing.body.id, {
        type: 'PURCHASE',
        quantity: 1000,
      }).expect(201);
      await move(t.token, ing.body.id, { type: 'WASTE', quantity: 400 }).expect(
        201,
      );
      const res = await getIngredient(t.token, ing.body.id).expect(200);
      expect(res.body.currentStock).toBe(600);
    });

    it('cannot be told to record a CONSUMPTION directly', async () => {
      const t = await newTenant('Fake Consumption Cafe');
      const ing = await addIngredient(t.token, {
        name: 'Oil',
        unit: 'MILLILITRE',
      }).expect(201);

      // Making stock vanish without a sale is the inventory equivalent of
      // voiding an order to cover theft. Only the server writes CONSUMPTION.
      await move(t.token, ing.body.id, {
        type: 'CONSUMPTION',
        quantity: 1000,
      }).expect(400);
    });

    it('is append-only even to the app role', async () => {
      const t = await newTenant('Immutable Ledger Cafe');
      const ing = await addIngredient(t.token, {
        name: 'Salt',
        unit: 'GRAM',
      }).expect(201);
      await move(t.token, ing.body.id, { type: 'WASTE', quantity: 500 }).expect(
        201,
      );

      const appDb = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: process.env.DATABASE_URL_APP,
        }),
      });
      try {
        // Covering up spillage by editing the ledger.
        await expect(
          appDb.$transaction(async (db) => {
            await db.$executeRaw`SELECT set_config('app.restaurant_id', ${t.restaurantId}, true)`;
            return db.stockMovement.deleteMany({
              where: { ingredientId: ing.body.id },
            });
          }),
        ).rejects.toThrow();
      } finally {
        await appDb.$disconnect();
      }
    });

    it('records an adjustment without erasing the discrepancy', async () => {
      const t = await newTenant('Count Cafe');
      const ing = await addIngredient(t.token, {
        name: 'Sugar',
        unit: 'GRAM',
      }).expect(201);
      await move(t.token, ing.body.id, {
        type: 'PURCHASE',
        quantity: 1000,
      }).expect(201);

      // A stock count finds 900. The 100 shortfall stays visible.
      await api()
        .post(`/api/v1/ingredients/${ing.body.id}/adjustments`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ quantity: -100, note: 'stock count' })
        .expect(201);

      const res = await getIngredient(t.token, ing.body.id).expect(200);
      expect(res.body.currentStock).toBe(900);
      expect(res.body.movements).toHaveLength(2); // history intact
    });

    it('rejects a zero-quantity adjustment', async () => {
      const t = await newTenant('Zero Cafe');
      const ing = await addIngredient(t.token, {
        name: 'Z',
        unit: 'GRAM',
      }).expect(201);
      await api()
        .post(`/api/v1/ingredients/${ing.body.id}/adjustments`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ quantity: 0 })
        .expect(400);
    });
  });

  describe('recipes and automatic depletion', () => {
    it('depletes stock when an order is placed', async () => {
      const t = await newTenant('Deplete Cafe');
      const paneer = await addIngredient(t.token, {
        name: 'Paneer',
        unit: 'GRAM',
      }).expect(201);
      await move(t.token, paneer.body.id, {
        type: 'PURCHASE',
        quantity: 10000,
      }).expect(201);

      // One momo plate uses 50g of paneer.
      await api()
        .put(`/api/v1/products/${t.productId}/recipe`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ ingredientId: paneer.body.id, quantity: 50 }] })
        .expect(200);

      await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ productId: t.productId, quantity: 3 }] })
        .expect(201);

      const res = await getIngredient(t.token, paneer.body.id).expect(200);
      // 10000 - (50 x 3)
      expect(res.body.currentStock).toBe(9850);
      const consumption = res.body.movements.find(
        (m: { type: string }) => m.type === 'CONSUMPTION',
      );
      expect(consumption.quantity).toBe(-150);
      // Traceable back to the sale that caused it.
      expect(consumption.orderId).toBeTruthy();
    });

    it('writes one movement per ingredient per order, not per line', async () => {
      const t = await newTenant('Aggregate Cafe');
      const flour = await addIngredient(t.token, {
        name: 'Flour',
        unit: 'GRAM',
      }).expect(201);
      const second = await api()
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ name: 'Chicken Momo', priceMinor: 12000 })
        .expect(201);

      // Both products use flour.
      for (const pid of [t.productId, second.body.id]) {
        await api()
          .put(`/api/v1/products/${pid}/recipe`)
          .set('Authorization', `Bearer ${t.token}`)
          .send({ items: [{ ingredientId: flour.body.id, quantity: 100 }] })
          .expect(200);
      }

      await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({
          items: [
            { productId: t.productId, quantity: 2 },
            { productId: second.body.id, quantity: 1 },
          ],
        })
        .expect(201);

      const res = await getIngredient(t.token, flour.body.id).expect(200);
      expect(res.body.movements).toHaveLength(1); // one row, not two
      expect(res.body.movements[0].quantity).toBe(-300); // (100x2) + (100x1)
    });

    it('sells a product with no recipe without depleting anything', async () => {
      const t = await newTenant('No Recipe Cafe');
      const ing = await addIngredient(t.token, {
        name: 'Unused',
        unit: 'GRAM',
      }).expect(201);
      await move(t.token, ing.body.id, {
        type: 'PURCHASE',
        quantity: 500,
      }).expect(201);

      // A bottled drink is bought and sold as-is.
      await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ productId: t.productId, quantity: 1 }] })
        .expect(201);

      const res = await getIngredient(t.token, ing.body.id).expect(200);
      expect(res.body.currentStock).toBe(500);
    });

    it('still sells when stock is insufficient, and records the shortfall', async () => {
      const t = await newTenant('Oversell Cafe');
      const ing = await addIngredient(t.token, {
        name: 'Scarce',
        unit: 'GRAM',
      }).expect(201);
      await move(t.token, ing.body.id, {
        type: 'PURCHASE',
        quantity: 100,
      }).expect(201);
      await api()
        .put(`/api/v1/products/${t.productId}/recipe`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ ingredientId: ing.body.id, quantity: 80 }] })
        .expect(200);

      // A restaurant that cannot sell because a database says zero is worse
      // than a negative number an owner can see and act on.
      await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ productId: t.productId, quantity: 3 }] })
        .expect(201);

      const res = await getIngredient(t.token, ing.body.id).expect(200);
      expect(res.body.currentStock).toBe(-140); // 100 - 240, visible not hidden
    });

    it('replaces a recipe wholesale so an ingredient can be removed', async () => {
      const t = await newTenant('Replace Cafe');
      const a = await addIngredient(t.token, {
        name: 'A',
        unit: 'GRAM',
      }).expect(201);
      const b = await addIngredient(t.token, {
        name: 'B',
        unit: 'GRAM',
      }).expect(201);

      await api()
        .put(`/api/v1/products/${t.productId}/recipe`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({
          items: [
            { ingredientId: a.body.id, quantity: 10 },
            { ingredientId: b.body.id, quantity: 20 },
          ],
        })
        .expect(200);

      const after = await api()
        .put(`/api/v1/products/${t.productId}/recipe`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ ingredientId: a.body.id, quantity: 10 }] })
        .expect(200);
      expect(after.body.items).toHaveLength(1);
    });

    it('rejects a duplicate ingredient in one recipe', async () => {
      const t = await newTenant('Dup Recipe Cafe');
      const a = await addIngredient(t.token, {
        name: 'A',
        unit: 'GRAM',
      }).expect(201);
      await api()
        .put(`/api/v1/products/${t.productId}/recipe`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({
          items: [
            { ingredientId: a.body.id, quantity: 10 },
            { ingredientId: a.body.id, quantity: 20 },
          ],
        })
        .expect(400);
    });
  });

  /**
   * A reversed sale did not consume its ingredients. Revenue has always
   * excluded VOIDED and CANCELLED; stock did not, so every void quietly leaked
   * ingredients out of the ledger forever.
   */
  describe('stock returned when a sale is reversed', () => {
    // 10000g of paneer, a 50g/plate recipe, then one order of `quantity`.
    async function soldTenant(name: string, quantity: number) {
      const t = await newTenant(name);
      const paneer = await addIngredient(t.token, {
        name: 'Paneer',
        unit: 'GRAM',
      }).expect(201);
      await move(t.token, paneer.body.id, {
        type: 'PURCHASE',
        quantity: 10000,
      }).expect(201);
      await api()
        .put(`/api/v1/products/${t.productId}/recipe`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ ingredientId: paneer.body.id, quantity: 50 }] })
        .expect(200);
      const order = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ productId: t.productId, quantity }] })
        .expect(201);
      return {
        ...t,
        ingredientId: paneer.body.id as string,
        orderId: order.body.id as string,
      };
    }

    const setStatus = (token: string, id: string, status: string) =>
      api()
        .patch(`/api/v1/orders/${id}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send(status === 'VOIDED' ? { status, reason: 'test' } : { status });

    it('returns the stock when an order is VOIDED', async () => {
      const t = await soldTenant('Void Restock Cafe', 10);
      const sold = await getIngredient(t.token, t.ingredientId).expect(200);
      expect(sold.body.currentStock).toBe(9500); // 10000 - (50 x 10)

      await setStatus(t.token, t.orderId, 'VOIDED').expect(200);

      const after = await getIngredient(t.token, t.ingredientId).expect(200);
      expect(after.body.currentStock).toBe(10000);
    });

    it('returns the stock when an order is CANCELLED', async () => {
      const t = await soldTenant('Cancel Restock Cafe', 4);
      await setStatus(t.token, t.orderId, 'CANCELLED').expect(200);

      const after = await getIngredient(t.token, t.ingredientId).expect(200);
      expect(after.body.currentStock).toBe(10000);
    });

    it('appends the reversal, leaving the original depletion on the ledger', async () => {
      const t = await soldTenant('Ledger Restock Cafe', 2);
      await setStatus(t.token, t.orderId, 'VOIDED').expect(200);

      const res = await getIngredient(t.token, t.ingredientId).expect(200);
      const consumption = res.body.movements.filter(
        (m: { type: string }) => m.type === 'CONSUMPTION',
      );
      const returned = res.body.movements.filter(
        (m: { type: string }) => m.type === 'ADJUSTMENT',
      );
      // The depletion is not erased — the ledger is append-only, and an
      // auditor needs to see both halves.
      expect(consumption).toHaveLength(1);
      expect(consumption[0].quantity).toBe(-100);
      expect(returned).toHaveLength(1);
      expect(returned[0].quantity).toBe(100);
      // Traceable back to the sale that was reversed.
      expect(returned[0].orderId).toBe(t.orderId);
    });

    it('does NOT return stock when an order is merely completed', async () => {
      const t = await soldTenant('Complete Cafe', 6);
      await setStatus(t.token, t.orderId, 'PREPARING').expect(200);
      await setStatus(t.token, t.orderId, 'READY').expect(200);
      await setStatus(t.token, t.orderId, 'COMPLETED').expect(200);

      const after = await getIngredient(t.token, t.ingredientId).expect(200);
      expect(after.body.currentStock).toBe(9700); // 10000 - (50 x 6), unchanged
    });

    it('reverses nothing for an order that depleted nothing', async () => {
      const t = await newTenant('No Recipe Void Cafe');
      const ing = await addIngredient(t.token, {
        name: 'Unused',
        unit: 'GRAM',
      }).expect(201);
      await move(t.token, ing.body.id, {
        type: 'PURCHASE',
        quantity: 500,
      }).expect(201);
      const order = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ productId: t.productId, quantity: 1 }] })
        .expect(201);

      await setStatus(t.token, order.body.id, 'VOIDED').expect(200);

      const after = await getIngredient(t.token, ing.body.id).expect(200);
      expect(after.body.currentStock).toBe(500);
      expect(after.body.movements).toHaveLength(1); // just the PURCHASE
    });
  });

  describe('low stock', () => {
    it('flags an ingredient at or below its reorder level', async () => {
      const t = await newTenant('Low Cafe');
      const low = await addIngredient(t.token, {
        name: 'Low One',
        unit: 'GRAM',
        reorderLevel: 1000,
      }).expect(201);
      const fine = await addIngredient(t.token, {
        name: 'Fine One',
        unit: 'GRAM',
        reorderLevel: 100,
      }).expect(201);
      const untracked = await addIngredient(t.token, {
        name: 'Untracked',
        unit: 'GRAM',
      }).expect(201);

      await move(t.token, low.body.id, {
        type: 'PURCHASE',
        quantity: 500,
      }).expect(201);
      await move(t.token, fine.body.id, {
        type: 'PURCHASE',
        quantity: 5000,
      }).expect(201);

      const res = await api()
        .get('/api/v1/ingredients?lowStock=true')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);

      const names = res.body.map((r: { name: string }) => r.name);
      expect(names).toContain('Low One');
      expect(names).not.toContain('Fine One');
      // No reorder level means "do not track", not "a level of zero".
      expect(names).not.toContain('Untracked');
      expect(untracked.body.reorderLevel).toBeNull();
    });
  });

  describe('tenant isolation', () => {
    it("never lists another tenant's ingredients", async () => {
      const a = await newTenant('Iso Inv A');
      const b = await newTenant('Iso Inv B');
      await addIngredient(a.token, {
        name: 'Secret Spice',
        unit: 'GRAM',
      }).expect(201);

      const res = await api()
        .get('/api/v1/ingredients')
        .set('Authorization', `Bearer ${b.token}`)
        .expect(200);
      expect(res.body).toHaveLength(0);
    });

    it("cannot read another tenant's ingredient by id", async () => {
      const a = await newTenant('Read Inv A');
      const b = await newTenant('Read Inv B');
      const ing = await addIngredient(a.token, {
        name: 'X',
        unit: 'GRAM',
      }).expect(201);

      await getIngredient(b.token, ing.body.id).expect(404);
    });

    it("cannot record a movement against another tenant's ingredient", async () => {
      const a = await newTenant('Move Inv A');
      const b = await newTenant('Move Inv B');
      const ing = await addIngredient(a.token, {
        name: 'Y',
        unit: 'GRAM',
      }).expect(201);

      await move(b.token, ing.body.id, { type: 'WASTE', quantity: 100 }).expect(
        404,
      );
    });

    it("cannot put another tenant's ingredient into a recipe", async () => {
      const a = await newTenant('Recipe Inv A');
      const b = await newTenant('Recipe Inv B');
      const ing = await addIngredient(a.token, {
        name: 'Z',
        unit: 'GRAM',
      }).expect(201);

      await api()
        .put(`/api/v1/products/${b.productId}/recipe`)
        .set('Authorization', `Bearer ${b.token}`)
        .send({ items: [{ ingredientId: ing.body.id, quantity: 10 }] })
        .expect(400); // "Unknown ingredient" — existence is not confirmed
    });
  });
});
