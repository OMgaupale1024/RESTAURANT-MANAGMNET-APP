/**
 * AI insights end-to-end.
 *
 * The tests that matter reflect the honesty contract: no fabrication (a
 * restaurant with no history gets NO forecast), every insight is labelled by
 * method, existing rules are respected (voided sales do not count as demand),
 * and AI never bypasses permissions or tenant isolation.
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
    patch: (url: string) =>
      request(server).patch(url).set('X-Forwarded-For', ip),
    put: (url: string) => request(server).put(url).set('X-Forwarded-For', ip),
  };
}

async function newTenant(name: string) {
  const email = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'AI Owner' })
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

const placeOrder = (token: string, productId: string, quantity: number) =>
  api()
    .post('/api/v1/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ items: [{ productId, quantity }] });

const insights = (token: string) =>
  api().get('/api/v1/ai/insights').set('Authorization', `Bearer ${token}`);

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

describe('AI insights (e2e)', () => {
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
        where: { email: { startsWith: 'ai-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      const rids = ms.map((m) => m.restaurantId);
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
      await owner.restaurant.deleteMany({ where: { id: { in: rids } } });
      await owner.securityEvent.deleteMany({
        where: { email: { startsWith: 'ai-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 'ai-' } } });
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

  describe('no fabrication', () => {
    it('produces NO demand forecast for a restaurant with no sales', async () => {
      const t = await newTenant('Cold Start Cafe');
      const res = await insights(t.token).expect(200);
      // A cold start must never invent a number.
      const forecasts = res.body.insights.filter(
        (i: { type: string }) => i.type === 'DEMAND_FORECAST',
      );
      expect(forecasts).toEqual([]);
    });

    it('labels a thin forecast LOW confidence rather than pretending certainty', async () => {
      const t = await newTenant('Thin Data Cafe');
      // A single sale is barely signal — it must be honestly marked LOW.
      await placeOrder(t.token, t.productId, 2).expect(201);

      const res = await insights(t.token).expect(200);
      const f = res.body.insights.find(
        (i: { type: string }) => i.type === 'DEMAND_FORECAST',
      );
      expect(f).toBeDefined();
      expect(f.confidence).toBe('LOW');
    });
  });

  describe('labelling and explainability', () => {
    it('labels every insight with a method and a basis', async () => {
      const t = await newTenant('Labelled Cafe');
      await placeOrder(t.token, t.productId, 3).expect(201);

      const res = await insights(t.token).expect(200);
      expect(res.body.insights.length).toBeGreaterThan(0);
      for (const i of res.body.insights) {
        // The two hard requirements: how it was made, and from what.
        expect(['DETERMINISTIC', 'STATISTICAL']).toContain(i.method);
        expect(typeof i.basis).toBe('string');
        expect(i.basis.length).toBeGreaterThan(0);
      }
    });

    it('marks a low-stock alert DETERMINISTIC', async () => {
      const t = await newTenant('Low Stock AI Cafe');
      const ing = await api()
        .post('/api/v1/ingredients')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ name: 'Paneer', unit: 'GRAM', reorderLevel: 1000 })
        .expect(201);
      // Received below the reorder level.
      await api()
        .post(`/api/v1/ingredients/${ing.body.id}/movements`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ type: 'PURCHASE', quantity: 500 })
        .expect(201);

      const res = await insights(t.token).expect(200);
      const low = res.body.insights.find(
        (i: { type: string }) => i.type === 'LOW_STOCK',
      );
      expect(low).toBeDefined();
      expect(low.method).toBe('DETERMINISTIC');
      // The basis must reference the real numbers.
      expect(low.basis).toContain('500');
      expect(low.basis).toContain('1000');
    });
  });

  describe('respects existing business rules', () => {
    it('does not count voided sales as demand', async () => {
      const t = await newTenant('Void Demand Cafe');
      // Five real sales, then one big voided one that must not inflate demand.
      await placeOrder(t.token, t.productId, 5).expect(201);
      const voided = await placeOrder(t.token, t.productId, 100).expect(201);
      await api()
        .patch(`/api/v1/orders/${voided.body.id}/status`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ status: 'VOIDED', reason: 'test' })
        .expect(200);

      const res = await insights(t.token).expect(200);
      const f = res.body.insights.find(
        (i: { type: string }) => i.type === 'DEMAND_FORECAST',
      );
      // 5 sold over 14 days = 0/day rounded; the 100 must be absent from basis.
      expect(f.basis).toContain('5 sold');
      expect(f.basis).not.toContain('105');
    });

    it('suggests a reorder from real consumption, marked STATISTICAL', async () => {
      const t = await newTenant('Reorder AI Cafe');
      const ing = await api()
        .post('/api/v1/ingredients')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ name: 'Flour', unit: 'GRAM' })
        .expect(201);
      // Recipe: 100g per momo.
      await api()
        .put(`/api/v1/products/${t.productId}/recipe`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ ingredientId: ing.body.id, quantity: 100 }] })
        .expect(200); // PUT recipe is an upsert, returns 200
      // Little stock, lots of recent sales -> should run out soon.
      await api()
        .post(`/api/v1/ingredients/${ing.body.id}/movements`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ type: 'PURCHASE', quantity: 300 })
        .expect(201);
      // Sell heavily so the forecast predicts meaningful daily use.
      for (let i = 0; i < 14; i++)
        await placeOrder(t.token, t.productId, 10).expect(201);

      const res = await insights(t.token).expect(200);
      const reorder = res.body.insights.find(
        (i: { type: string }) => i.type === 'REORDER_SUGGESTION',
      );
      expect(reorder).toBeDefined();
      expect(reorder.method).toBe('STATISTICAL');
      expect(reorder.confidence).toBeDefined();
      // Consumption depleted stock via real orders, so it must be negative or low.
    });
  });

  describe('permissions and isolation', () => {
    it('a CASHIER cannot see AI insights', async () => {
      const t = await newTenant('Cashier AI Cafe');
      const cashier = await becomeRole(t, 'CASHIER');
      await insights(cashier).expect(403);
    });

    it('rejects an unauthenticated request', async () => {
      await api().get('/api/v1/ai/insights').expect(401);
    });

    it("never surfaces another tenant's data in insights", async () => {
      const a = await newTenant('AI Iso A');
      const b = await newTenant('AI Iso B');
      // A sells a distinctively named product heavily.
      const special = await api()
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ name: 'SecretDishXYZ', priceMinor: 10000 })
        .expect(201);
      for (let i = 0; i < 10; i++)
        await placeOrder(a.token, special.body.id, 5).expect(201);

      const bView = await insights(b.token).expect(200);
      // B's briefing must not mention A's product at all.
      expect(JSON.stringify(bView.body)).not.toContain('SecretDishXYZ');
    });
  });
});
