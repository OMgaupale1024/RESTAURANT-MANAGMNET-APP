/**
 * Procurement end-to-end.
 *
 * The tests that matter: a received purchase order writes ordinary PURCHASE
 * stock movements (no second history), the lifecycle whitelist holds, supplier
 * insights and reorder suggestions read the same ledger, and everything stays
 * tenant-scoped and permission-gated.
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
    patch: (url: string) =>
      request(server).patch(url).set('X-Forwarded-For', ip),
  };
}

async function newTenant(name: string) {
  const email = `pr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Proc Owner' })
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

const addSupplier = (token: string, name: string) =>
  api()
    .post('/api/v1/suppliers')
    .set('Authorization', `Bearer ${token}`)
    .send({ name });

const addIngredient = (token: string, body: Record<string, unknown>) =>
  api()
    .post('/api/v1/ingredients')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

const createPO = (token: string, body: Record<string, unknown>) =>
  api()
    .post('/api/v1/purchase-orders')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

const transition = (token: string, id: string, status: string) =>
  api()
    .patch(`/api/v1/purchase-orders/${id}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status });

const getIngredient = (token: string, id: string) =>
  api()
    .get(`/api/v1/ingredients/${id}`)
    .set('Authorization', `Bearer ${token}`);

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

/** A tenant with one supplier and one ingredient, ready to buy. */
async function withStock(name: string, reorderLevel?: number) {
  const t = await newTenant(name);
  const supplier = await addSupplier(t.token, 'Mandi').expect(201);
  const ing = await addIngredient(t.token, {
    name: 'Paneer',
    unit: 'GRAM',
    ...(reorderLevel !== undefined ? { reorderLevel } : {}),
  }).expect(201);
  return {
    ...t,
    supplierId: supplier.body.id as string,
    ingredientId: ing.body.id as string,
  };
}

describe('Procurement (e2e)', () => {
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
      'orders',
      'stock_movements',
    ]) {
      await owner.$executeRawUnsafe(`ALTER TABLE ${tbl} DISABLE TRIGGER USER`);
    }
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 'pr-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      const rids = ms.map((m) => m.restaurantId);
      // Dependency order: PO (cascades its items) → movements → ingredients →
      // suppliers, all RESTRICT-guarded, before the restaurant.
      await owner.purchaseOrder.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.stockMovement.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.ingredient.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.supplier.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.order.deleteMany({ where: { restaurantId: { in: rids } } });
      await owner.restaurant.deleteMany({ where: { id: { in: rids } } });
      await owner.securityEvent.deleteMany({
        where: { email: { startsWith: 'pr-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 'pr-' } } });
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

  describe('purchase order lifecycle', () => {
    it('drafts, orders and receives — receiving writes PURCHASE stock', async () => {
      const t = await withStock('Receive Cafe');
      const po = await createPO(t.token, {
        supplierId: t.supplierId,
        items: [
          {
            ingredientId: t.ingredientId,
            quantity: 5000,
            totalCostMinor: 20000,
          },
        ],
      }).expect(201);
      expect(po.body.status).toBe('DRAFT');

      await transition(t.token, po.body.id, 'ORDERED').expect(200);
      const received = await transition(t.token, po.body.id, 'RECEIVED').expect(
        200,
      );
      expect(received.body.status).toBe('RECEIVED');
      expect(received.body.receivedAt).toBeTruthy();

      // The stock actually arrived, as an ordinary PURCHASE movement carrying
      // the cost — the single source of purchase history.
      const ing = await getIngredient(t.token, t.ingredientId).expect(200);
      expect(ing.body.currentStock).toBe(5000);
      expect(ing.body.avgUnitCostMinor).toBe(4); // 20000 / 5000
      const purchase = ing.body.movements.find(
        (m: { type: string }) => m.type === 'PURCHASE',
      );
      expect(purchase.totalCostMinor).toBe(20000);
    });

    it('refuses a status skip and a re-receive', async () => {
      const t = await withStock('Skip Cafe');
      const po = await createPO(t.token, {
        supplierId: t.supplierId,
        items: [{ ingredientId: t.ingredientId, quantity: 1000 }],
      }).expect(201);
      // DRAFT cannot jump straight to RECEIVED.
      await transition(t.token, po.body.id, 'RECEIVED').expect(409);

      await transition(t.token, po.body.id, 'ORDERED').expect(200);
      await transition(t.token, po.body.id, 'RECEIVED').expect(200);
      // A received order is terminal — no second receive (which would double stock).
      await transition(t.token, po.body.id, 'RECEIVED').expect(409);

      const ing = await getIngredient(t.token, t.ingredientId).expect(200);
      expect(ing.body.currentStock).toBe(1000); // received once, not twice
    });

    it('cancels a draft without touching stock', async () => {
      const t = await withStock('Cancel Cafe');
      const po = await createPO(t.token, {
        supplierId: t.supplierId,
        items: [{ ingredientId: t.ingredientId, quantity: 1000 }],
      }).expect(201);
      await transition(t.token, po.body.id, 'CANCELLED').expect(200);
      // A cancelled order is terminal.
      await transition(t.token, po.body.id, 'ORDERED').expect(409);

      const ing = await getIngredient(t.token, t.ingredientId).expect(200);
      expect(ing.body.currentStock).toBe(0);
    });

    it('rejects an unknown supplier or a duplicate ingredient', async () => {
      const t = await withStock('Bad PO Cafe');
      await createPO(t.token, {
        supplierId: '00000000-0000-7000-8000-000000000000',
        items: [{ ingredientId: t.ingredientId, quantity: 100 }],
      }).expect(400);
      await createPO(t.token, {
        supplierId: t.supplierId,
        items: [
          { ingredientId: t.ingredientId, quantity: 100 },
          { ingredientId: t.ingredientId, quantity: 200 },
        ],
      }).expect(400);
    });

    it('lists and filters by status', async () => {
      const t = await withStock('List Cafe');
      const po = await createPO(t.token, {
        supplierId: t.supplierId,
        items: [{ ingredientId: t.ingredientId, quantity: 100 }],
      }).expect(201);
      await transition(t.token, po.body.id, 'ORDERED').expect(200);

      const drafts = await api()
        .get('/api/v1/purchase-orders?status=DRAFT')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      expect(drafts.body).toHaveLength(0);
      const ordered = await api()
        .get('/api/v1/purchase-orders?status=ORDERED')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      expect(ordered.body).toHaveLength(1);
    });
  });

  describe('supplier insights & reorder suggestions', () => {
    it('rolls up supplier spend from received purchases', async () => {
      const t = await withStock('Insights Cafe');
      const po = await createPO(t.token, {
        supplierId: t.supplierId,
        items: [
          {
            ingredientId: t.ingredientId,
            quantity: 1000,
            totalCostMinor: 50000,
          },
        ],
      }).expect(201);
      await transition(t.token, po.body.id, 'ORDERED').expect(200);
      await transition(t.token, po.body.id, 'RECEIVED').expect(200);

      const res = await api()
        .get('/api/v1/suppliers/insights')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      const mandi = res.body.find((s: { name: string }) => s.name === 'Mandi');
      expect(mandi.totalSpentMinor).toBe(50000);
      expect(mandi.purchaseCount).toBe(1);
      expect(mandi.topIngredient.name).toBe('Paneer');
    });

    it('suggests a reorder for a low ingredient with its last supplier', async () => {
      const t = await withStock('Reorder Cafe', 1000);
      // Receive only 500 (below the 1000 reorder level) from Mandi.
      const po = await createPO(t.token, {
        supplierId: t.supplierId,
        items: [
          {
            ingredientId: t.ingredientId,
            quantity: 500,
            totalCostMinor: 10000,
          },
        ],
      }).expect(201);
      await transition(t.token, po.body.id, 'ORDERED').expect(200);
      await transition(t.token, po.body.id, 'RECEIVED').expect(200);

      const res = await api()
        .get('/api/v1/inventory/reorder-suggestions')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      const row = res.body.find((r: { name: string }) => r.name === 'Paneer');
      expect(row).toBeDefined();
      expect(row.suggestedQuantity).toBeGreaterThan(0);
      expect(row.lastSupplier.name).toBe('Mandi');
    });
  });

  describe('tenant isolation & permissions', () => {
    it("cannot draft against another tenant's supplier", async () => {
      const a = await withStock('Iso A');
      const b = await withStock('Iso B');
      await createPO(b.token, {
        supplierId: a.supplierId, // A's supplier — not visible to B
        items: [{ ingredientId: b.ingredientId, quantity: 100 }],
      }).expect(400);
    });

    it("never lists another tenant's purchase orders", async () => {
      const a = await withStock('Iso List A');
      const b = await withStock('Iso List B');
      await createPO(a.token, {
        supplierId: a.supplierId,
        items: [{ ingredientId: a.ingredientId, quantity: 100 }],
      }).expect(201);

      const bView = await api()
        .get('/api/v1/purchase-orders')
        .set('Authorization', `Bearer ${b.token}`)
        .expect(200);
      expect(bView.body).toHaveLength(0);
    });

    it('a CASHIER can neither read nor draft procurement', async () => {
      const t = await withStock('Cashier Proc Cafe');
      const cashier = await becomeRole(t, 'CASHIER');
      await api()
        .get('/api/v1/purchase-orders')
        .set('Authorization', `Bearer ${cashier}`)
        .expect(403);
      await createPO(cashier, {
        supplierId: t.supplierId,
        items: [{ ingredientId: t.ingredientId, quantity: 100 }],
      }).expect(403);
    });
  });
});
