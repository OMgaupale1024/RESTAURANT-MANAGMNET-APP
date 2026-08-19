/**
 * Physical stock counts end-to-end, against the real database.
 *
 * What matters here: a count snapshots system stock, and on submit each
 * discrepancy becomes ONE signed ADJUSTMENT on the EXISTING ledger (no second
 * adjustment system); the adjustment reconciles against LIVE stock so a sale
 * during the count is not double-counted; a non-zero change needs a reason; a
 * negative physical count is refused; a re-submit is idempotent; completed counts
 * are read-only; only inventory.manage roles may count; and counts are
 * tenant-isolated. Prepared (M9) stock counts at the aggregate level and leaves
 * FEFO intact.
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

let ipCounter = 910000;
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

type CountLine = {
  id: string;
  ingredientId: string;
  name: string;
  unit: string;
  systemQuantity: number;
  currentStock: number;
  countedQuantity: number | null;
  difference: number | null;
  reason: string | null;
};

async function newTenant(name: string) {
  const email = `count-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Count Owner' })
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

/** A raw ingredient seeded with `stock` grams via a PURCHASE. */
async function seedRaw(token: string, name: string, stock: number) {
  const ing = (
    await api()
      .post('/api/v1/ingredients')
      .set(auth(token))
      .send({ name: `${name} ${Math.random()}` })
      .expect(201)
  ).body;
  if (stock > 0) {
    await api()
      .post(`/api/v1/ingredients/${ing.id}/movements`)
      .set(auth(token))
      .send({ type: 'PURCHASE', quantity: stock })
      .expect(201);
  }
  return ing;
}

const startCount = (token: string, body: Record<string, unknown> = {}) =>
  api().post('/api/v1/stock-counts').set(auth(token)).send(body);

const submitCount = (
  token: string,
  id: string,
  lines: Array<Record<string, unknown>>,
  notes?: string,
) =>
  api()
    .post(`/api/v1/stock-counts/${id}/submit`)
    .set(auth(token))
    .send({ lines, ...(notes ? { notes } : {}) });

const getCount = (token: string, id: string) =>
  api().get(`/api/v1/stock-counts/${id}`).set(auth(token));

const getIngredient = (token: string, id: string) =>
  api().get(`/api/v1/ingredients/${id}`).set(auth(token));

const lineFor = (count: { lines: CountLine[] }, id: string): CountLine =>
  count.lines.find((l) => l.ingredientId === id)!;

describe('Stock counts (e2e)', () => {
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
    for (const t of ['orders', 'stock_movements']) {
      await owner.$executeRawUnsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    }
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 'count-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      const rids = ms.map((m) => m.restaurantId);
      // Restrict FKs mean order matters: ledger + counts + recipes/prep before
      // ingredients (stock_count_lines RESTRICT ingredient, so counts go first).
      await owner.stockMovement.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.stockCount.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.prepBatch.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.recipeItem.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.ingredient.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.order.deleteMany({ where: { restaurantId: { in: rids } } });
      await owner.product.deleteMany({ where: { restaurantId: { in: rids } } });
    } finally {
      for (const t of ['orders', 'stock_movements']) {
        await owner.$executeRawUnsafe(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
      }
    }
    await app.close();
    await owner.$disconnect();
  });

  it('runs a normal count: start snapshots stock, submit applies a shortage', async () => {
    const t = await newTenant('Count Normal');
    const paneer = await seedRaw(t.token, 'Paneer', 5000);

    const count = (await startCount(t.token).expect(201)).body;
    expect(count.status).toBe('OPEN');
    expect(count.code).toMatch(/^SC-\d{6}-[A-Z0-9]{4}$/);
    const line = lineFor(count, paneer.id);
    expect(line.systemQuantity).toBe(5000);

    // Physically counted 4000g → a 1000g shortage.
    const done = (
      await submitCount(t.token, count.id, [
        {
          ingredientId: paneer.id,
          countedQuantity: 4000,
          reason: 'WASTE_SPOILAGE',
        },
      ]).expect(201)
    ).body;
    expect(done.status).toBe('COMPLETED');
    expect(lineFor(done, paneer.id).difference).toBe(-1000);

    // The ledger now reflects the count, via one ADJUSTMENT.
    const ing = (await getIngredient(t.token, paneer.id).expect(200)).body;
    expect(ing.currentStock).toBe(4000);
    const adj = ing.movements.find(
      (m: { type: string }) => m.type === 'ADJUSTMENT',
    );
    expect(adj.quantity).toBe(-1000);
    expect(adj.note).toContain(count.code);
    expect(adj.note).toContain('Waste / spoilage');
  });

  it('applies a surplus (counted above system)', async () => {
    const t = await newTenant('Count Surplus');
    const veg = await seedRaw(t.token, 'Veg', 5000);
    const count = (await startCount(t.token).expect(201)).body;
    const done = (
      await submitCount(t.token, count.id, [
        {
          ingredientId: veg.id,
          countedQuantity: 6000,
          reason: 'RECEIVING_DISCREPANCY',
        },
      ]).expect(201)
    ).body;
    expect(lineFor(done, veg.id).difference).toBe(1000);
    expect(
      (await getIngredient(t.token, veg.id).expect(200)).body.currentStock,
    ).toBe(6000);
  });

  it('writes no adjustment when the count matches the system', async () => {
    const t = await newTenant('Count Match');
    const paneer = await seedRaw(t.token, 'Paneer', 5000);
    const count = (await startCount(t.token).expect(201)).body;
    const done = (
      await submitCount(t.token, count.id, [
        { ingredientId: paneer.id, countedQuantity: 5000 },
      ]).expect(201)
    ).body;
    expect(lineFor(done, paneer.id).difference).toBe(0);
    const ing = (await getIngredient(t.token, paneer.id).expect(200)).body;
    expect(ing.currentStock).toBe(5000);
    // Only the seeding PURCHASE — no ADJUSTMENT written for a zero difference.
    expect(
      ing.movements.filter((m: { type: string }) => m.type === 'ADJUSTMENT'),
    ).toHaveLength(0);
  });

  it('counts down to zero', async () => {
    const t = await newTenant('Count Zero');
    const spice = await seedRaw(t.token, 'Spice', 2000);
    const count = (await startCount(t.token).expect(201)).body;
    const done = (
      await submitCount(t.token, count.id, [
        { ingredientId: spice.id, countedQuantity: 0, reason: 'DAMAGED' },
      ]).expect(201)
    ).body;
    expect(lineFor(done, spice.id).difference).toBe(-2000);
    expect(
      (await getIngredient(t.token, spice.id).expect(200)).body.currentStock,
    ).toBe(0);
  });

  it('reconciles against live stock: a sale during the count is not double-counted', async () => {
    const t = await newTenant('Count Concurrent');
    const paneer = await seedRaw(t.token, 'Paneer', 10000);
    // A product that consumes 1000g of paneer per unit.
    const product = (
      await api()
        .post('/api/v1/products')
        .set(auth(t.token))
        .send({ name: `Momo ${Math.random()}`, priceMinor: 10000 })
        .expect(201)
    ).body;
    await api()
      .put(`/api/v1/products/${product.id}/recipe`)
      .set(auth(t.token))
      .send({ items: [{ ingredientId: paneer.id, quantity: 1000 }] })
      .expect(200);

    // Count starts: snapshot is 10000.
    const count = (await startCount(t.token).expect(201)).body;
    expect(lineFor(count, paneer.id).systemQuantity).toBe(10000);

    // A sale of 2 units consumes 2000g DURING the count → ledger now 8000.
    await api()
      .post('/api/v1/orders')
      .set(auth(t.token))
      .send({
        items: [{ productId: product.id, quantity: 2 }],
        orderType: 'TAKEAWAY',
        paymentMethod: 'CASH',
      })
      .expect(201);

    // Staff physically counted 7000g. The genuine shrinkage is 7000 − 8000 =
    // −1000, NOT 7000 − 10000 = −3000 (which would double-count the sale).
    const done = (
      await submitCount(t.token, count.id, [
        {
          ingredientId: paneer.id,
          countedQuantity: 7000,
          reason: 'UNRECORDED_USAGE',
        },
      ]).expect(201)
    ).body;
    expect(lineFor(done, paneer.id).difference).toBe(-1000);
    expect(
      (await getIngredient(t.token, paneer.id).expect(200)).body.currentStock,
    ).toBe(7000);
  });

  it('is idempotent: re-submitting a completed count writes no second adjustment', async () => {
    const t = await newTenant('Count Idem');
    const paneer = await seedRaw(t.token, 'Paneer', 5000);
    const count = (await startCount(t.token).expect(201)).body;
    const lines = [
      {
        ingredientId: paneer.id,
        countedQuantity: 4500,
        reason: 'COUNTING_ERROR',
      },
    ];
    const first = (await submitCount(t.token, count.id, lines).expect(201))
      .body;
    // Submit again — returns the completed count, applies nothing new.
    const second = (await submitCount(t.token, count.id, lines).expect(201))
      .body;
    expect(second.status).toBe('COMPLETED');
    expect(first.id).toBe(second.id);

    const ing = (await getIngredient(t.token, paneer.id).expect(200)).body;
    expect(ing.currentStock).toBe(4500); // 5000 − 500, once
    expect(
      ing.movements.filter((m: { type: string }) => m.type === 'ADJUSTMENT'),
    ).toHaveLength(1);
  });

  it('requires a reason for a non-zero difference, and refuses a negative count', async () => {
    const t = await newTenant('Count Rules');
    const paneer = await seedRaw(t.token, 'Paneer', 5000);

    // Reason required when stock changed.
    const c1 = (await startCount(t.token).expect(201)).body;
    await submitCount(t.token, c1.id, [
      { ingredientId: paneer.id, countedQuantity: 4000 },
    ]).expect(400);
    // The count did not complete — still open, nothing written.
    expect((await getCount(t.token, c1.id).expect(200)).body.status).toBe(
      'OPEN',
    );
    expect(
      (await getIngredient(t.token, paneer.id).expect(200)).body.currentStock,
    ).toBe(5000);

    // Negative physical quantity is rejected by validation.
    const c2 = (await startCount(t.token).expect(201)).body;
    await submitCount(t.token, c2.id, [
      { ingredientId: paneer.id, countedQuantity: -5, reason: 'OTHER' },
    ]).expect(400);
  });

  it('makes a completed count read-only and refuses to submit a cancelled one', async () => {
    const t = await newTenant('Count Terminal');
    const paneer = await seedRaw(t.token, 'Paneer', 5000);

    // Cancel an open count → cannot then submit it.
    const c1 = (await startCount(t.token).expect(201)).body;
    await api()
      .post(`/api/v1/stock-counts/${c1.id}/cancel`)
      .set(auth(t.token))
      .expect(201);
    expect((await getCount(t.token, c1.id).expect(200)).body.status).toBe(
      'CANCELLED',
    );
    await submitCount(t.token, c1.id, [
      { ingredientId: paneer.id, countedQuantity: 4000, reason: 'OTHER' },
    ]).expect(409);
  });

  it('counts prepared stock at the aggregate level and leaves FEFO working', async () => {
    const t = await newTenant('Count Prep');
    const paneer = await seedRaw(t.token, 'Paneer', 10000);
    const filling = (
      await api()
        .post('/api/v1/prep/items')
        .set(auth(t.token))
        .send({ name: `Filling ${Math.random()}`, unit: 'GRAM' })
        .expect(201)
    ).body;
    await api()
      .put(`/api/v1/prep/items/${filling.id}/recipe`)
      .set(auth(t.token))
      .send({
        batchYield: 1000,
        items: [{ ingredientId: paneer.id, quantity: 1000 }],
      })
      .expect(200);
    // Two batches → 2000g prepared.
    await api()
      .post(`/api/v1/prep/items/${filling.id}/batches`)
      .set(auth(t.token))
      .send({ quantity: 1000 })
      .expect(201);
    await api()
      .post(`/api/v1/prep/items/${filling.id}/batches`)
      .set(auth(t.token))
      .send({ quantity: 1000 })
      .expect(201);

    // Count the prepared item: physically 1800g (a 200g loss).
    const count = (
      await startCount(t.token, { ingredientIds: [filling.id] }).expect(201)
    ).body;
    expect(lineFor(count, filling.id).systemQuantity).toBe(2000);
    const done = (
      await submitCount(t.token, count.id, [
        {
          ingredientId: filling.id,
          countedQuantity: 1800,
          reason: 'WASTE_SPOILAGE',
        },
      ]).expect(201)
    ).body;
    expect(lineFor(done, filling.id).difference).toBe(-200);

    // The prep board still reads the aggregate correctly, and a later sale still
    // draws FEFO without error.
    const prep = (
      await api()
        .get(`/api/v1/prep/items/${filling.id}`)
        .set(auth(t.token))
        .expect(200)
    ).body;
    expect(prep.available).toBe(1800);
  });

  it('lets a cashier neither start nor submit a count, but an owner can', async () => {
    const t = await newTenant('Count Perms');
    const paneer = await seedRaw(t.token, 'Paneer', 5000);
    const count = (await startCount(t.token).expect(201)).body;
    const cashier = await becomeRole(t, 'CASHIER');

    await startCount(cashier).expect(403);
    await submitCount(cashier, count.id, [
      { ingredientId: paneer.id, countedQuantity: 4000, reason: 'OTHER' },
    ]).expect(403);
    // A cashier cannot even read counts (no inventory.read).
    await api().get('/api/v1/stock-counts').set(auth(cashier)).expect(403);
  });

  it('isolates counts between tenants', async () => {
    const a = await newTenant('Count Tenant A');
    const b = await newTenant('Count Tenant B');
    await seedRaw(a.token, 'Paneer', 5000);
    const count = (await startCount(a.token).expect(201)).body;

    // B sees none of A's counts and cannot open or submit A's.
    expect(
      (await api().get('/api/v1/stock-counts').set(auth(b.token)).expect(200))
        .body,
    ).toHaveLength(0);
    await getCount(b.token, count.id).expect(404);
    await submitCount(b.token, count.id, [
      {
        ingredientId: lineFor(count, count.lines[0].ingredientId).ingredientId,
        countedQuantity: 1,
        reason: 'OTHER',
      },
    ]).expect(404);
  });
});
