/**
 * Prep inventory end-to-end, against the real database.
 *
 * What matters here: preparing a batch consumes raw stock and produces prepared
 * stock ON THE SAME LEDGER (no second inventory), atomically; a shortfall blocks
 * the batch; a product sale draws prepared stock down FEFO and never touches an
 * expired batch; waste is auditable; only a manager configures; and prep is
 * tenant-isolated.
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

let ipCounter = 860000;
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
    delete: (url: string) =>
      request(server).delete(url).set('X-Forwarded-For', ip),
  };
}

async function newTenant(name: string) {
  const email = `prep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Prep Owner' })
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
  // ingredients default to GRAM.
  if (stock > 0) {
    await api()
      .post(`/api/v1/ingredients/${ing.id}/movements`)
      .set(auth(token))
      .send({ type: 'PURCHASE', quantity: stock })
      .expect(201);
  }
  return ing;
}

const addPrepItem = (
  token: string,
  name: string,
  body: Record<string, unknown> = {},
) =>
  api()
    .post('/api/v1/prep/items')
    .set(auth(token))
    .send({ name: `${name} ${Math.random()}`, unit: 'GRAM', ...body });

const setPrepRecipe = (
  token: string,
  id: string,
  batchYield: number,
  items: Array<{ ingredientId: string; quantity: number }>,
) =>
  api()
    .put(`/api/v1/prep/items/${id}/recipe`)
    .set(auth(token))
    .send({ batchYield, items });

const prepareBatch = (
  token: string,
  id: string,
  body: Record<string, unknown>,
) => api().post(`/api/v1/prep/items/${id}/batches`).set(auth(token)).send(body);

const getPrep = (token: string, id: string) =>
  api().get(`/api/v1/prep/items/${id}`).set(auth(token));

const getIngredient = (token: string, id: string) =>
  api().get(`/api/v1/ingredients/${id}`).set(auth(token));

/** A product whose recipe uses `qtyPerUnit` of the prep item. */
async function productUsingPrep(
  token: string,
  prepItemId: string,
  qtyPerUnit: number,
) {
  const product = (
    await api()
      .post('/api/v1/products')
      .set(auth(token))
      .send({ name: `Momo ${Math.random()}`, priceMinor: 10000 })
      .expect(201)
  ).body;
  await api()
    .put(`/api/v1/products/${product.id}/recipe`)
    .set(auth(token))
    .send({ items: [{ ingredientId: prepItemId, quantity: qtyPerUnit }] })
    .expect(200);
  return product;
}

const placeOrder = (token: string, productId: string, quantity: number) =>
  api()
    .post('/api/v1/orders')
    .set(auth(token))
    .send({
      items: [{ productId, quantity }],
      orderType: 'TAKEAWAY',
      paymentMethod: 'CASH',
    });

describe('Prep inventory (e2e)', () => {
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
        where: { email: { startsWith: 'prep-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      const rids = ms.map((m) => m.restaurantId);
      // Restrict FKs mean order matters: ledger + prep + recipes before ingredients.
      await owner.stockMovement.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.prepBatch.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.prepRecipeItem.deleteMany({
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

  it('prepares a batch: raw stock falls and prepared stock rises, on one ledger', async () => {
    const t = await newTenant('Prep Make');
    const paneer = await seedRaw(t.token, 'Paneer', 5000);
    const veg = await seedRaw(t.token, 'Veg', 1000);
    const filling = (await addPrepItem(t.token, 'Paneer Filling').expect(201))
      .body;
    // 1000g paneer + 200g veg -> 1100g filling per standard batch.
    await setPrepRecipe(t.token, filling.id, 1100, [
      { ingredientId: paneer.id, quantity: 1000 },
      { ingredientId: veg.id, quantity: 200 },
    ]).expect(200);

    const batch = (
      await prepareBatch(t.token, filling.id, { quantity: 1100 }).expect(201)
    ).body;
    expect(batch.actualQuantity).toBe(1100);

    // Raw consumed by the recipe; prepared stock produced.
    expect(
      (await getIngredient(t.token, paneer.id).expect(200)).body.currentStock,
    ).toBe(4000);
    expect(
      (await getIngredient(t.token, veg.id).expect(200)).body.currentStock,
    ).toBe(800);
    const detail = (await getPrep(t.token, filling.id).expect(200)).body;
    expect(detail.available).toBe(1100);
    expect(detail.batches[0].remaining).toBe(1100);
  });

  it('records actual yield separate from expected, consuming raw by the recipe', async () => {
    const t = await newTenant('Prep Yield');
    const paneer = await seedRaw(t.token, 'Paneer', 5000);
    const filling = (await addPrepItem(t.token, 'Filling').expect(201)).body;
    await setPrepRecipe(t.token, filling.id, 1000, [
      { ingredientId: paneer.id, quantity: 1000 },
    ]).expect(200);

    // Planned 1000, actually got 900.
    const batch = (
      await prepareBatch(t.token, filling.id, {
        quantity: 1000,
        actualQuantity: 900,
      }).expect(201)
    ).body;
    expect(batch.actualQuantity).toBe(900);
    expect(batch.variance).toEqual({ delta: -100, pct: -10 });

    // Raw consumed by the PLANNED recipe (1000), not the actual yield.
    expect(
      (await getIngredient(t.token, paneer.id).expect(200)).body.currentStock,
    ).toBe(4000);
    // Prepared stock = the actual yield.
    expect(
      (await getPrep(t.token, filling.id).expect(200)).body.available,
    ).toBe(900);
  });

  it('blocks a batch when a raw component is short, writing nothing', async () => {
    const t = await newTenant('Prep Short');
    const paneer = await seedRaw(t.token, 'Paneer', 500); // only 500g
    const filling = (await addPrepItem(t.token, 'Filling').expect(201)).body;
    await setPrepRecipe(t.token, filling.id, 1000, [
      { ingredientId: paneer.id, quantity: 1000 }, // needs 1000g
    ]).expect(200);

    await prepareBatch(t.token, filling.id, { quantity: 1000 }).expect(400);

    // Nothing happened: raw untouched, no prepared stock, no batch.
    expect(
      (await getIngredient(t.token, paneer.id).expect(200)).body.currentStock,
    ).toBe(500);
    const detail = (await getPrep(t.token, filling.id).expect(200)).body;
    expect(detail.available).toBe(0);
    expect(detail.batches).toHaveLength(0);
  });

  it('draws prepared stock down FEFO when the product sells', async () => {
    const t = await newTenant('Prep FEFO');
    const paneer = await seedRaw(t.token, 'Paneer', 10000);
    const filling = (await addPrepItem(t.token, 'Filling').expect(201)).body;
    await setPrepRecipe(t.token, filling.id, 500, [
      { ingredientId: paneer.id, quantity: 500 },
    ]).expect(200);

    const soon = new Date(Date.now() + 3 * 3600_000).toISOString();
    const later = new Date(Date.now() + 12 * 3600_000).toISOString();
    const a = (
      await prepareBatch(t.token, filling.id, {
        quantity: 500,
        expiresAt: soon,
      }).expect(201)
    ).body;
    const b = (
      await prepareBatch(t.token, filling.id, {
        quantity: 500,
        expiresAt: later,
      }).expect(201)
    ).body;

    // Sell 6 momos × 50g = 300g of filling.
    const product = await productUsingPrep(t.token, filling.id, 50);
    await placeOrder(t.token, product.id, 6).expect(201);

    const detail = (await getPrep(t.token, filling.id).expect(200)).body;
    const remaining = Object.fromEntries(
      detail.batches.map((x: { id: string; remaining: number }) => [
        x.id,
        x.remaining,
      ]),
    );
    // Earlier-expiry batch A is drawn first: 500-300 = 200; B untouched.
    expect(remaining[a.id]).toBe(200);
    expect(remaining[b.id]).toBe(500);
    expect(detail.available).toBe(700); // 1000 - 300
  });

  it('never draws an expired batch; the sale still completes', async () => {
    const t = await newTenant('Prep Expiry');
    const paneer = await seedRaw(t.token, 'Paneer', 5000);
    const filling = (await addPrepItem(t.token, 'Filling').expect(201)).body;
    await setPrepRecipe(t.token, filling.id, 1000, [
      { ingredientId: paneer.id, quantity: 1000 },
    ]).expect(200);

    const past = new Date(Date.now() - 3600_000).toISOString();
    const expired = (
      await prepareBatch(t.token, filling.id, {
        quantity: 1000,
        expiresAt: past,
      }).expect(201)
    ).body;

    // Sell 2 × 50g = 100g. Only an expired batch exists.
    const product = await productUsingPrep(t.token, filling.id, 50);
    await placeOrder(t.token, product.id, 2).expect(201);

    const detail = (await getPrep(t.token, filling.id).expect(200)).body;
    const expiredRow = detail.batches.find(
      (x: { id: string }) => x.id === expired.id,
    );
    // The expired batch was NOT drawn down...
    expect(expiredRow.remaining).toBe(1000);
    // ...but the sale still consumed prepared stock (item goes honestly negative
    // against no live batch).
    expect(detail.available).toBe(900);
  });

  it('wastes from a batch, reducing its remaining and the item stock', async () => {
    const t = await newTenant('Prep Waste');
    const paneer = await seedRaw(t.token, 'Paneer', 5000);
    const filling = (await addPrepItem(t.token, 'Filling').expect(201)).body;
    await setPrepRecipe(t.token, filling.id, 1000, [
      { ingredientId: paneer.id, quantity: 1000 },
    ]).expect(200);
    const batch = (
      await prepareBatch(t.token, filling.id, { quantity: 1000 }).expect(201)
    ).body;

    await api()
      .post(`/api/v1/prep/batches/${batch.id}/waste`)
      .set(auth(t.token))
      .send({ quantity: 200, note: 'Spoiled' })
      .expect(201);
    // Cannot waste more than remains.
    await api()
      .post(`/api/v1/prep/batches/${batch.id}/waste`)
      .set(auth(t.token))
      .send({ quantity: 5000 })
      .expect(400);

    const detail = (await getPrep(t.token, filling.id).expect(200)).body;
    expect(detail.available).toBe(800);
    expect(detail.batches[0].remaining).toBe(800);
  });

  it('lets a cashier neither configure prep nor prepare batches', async () => {
    const t = await newTenant('Prep Perms');
    const paneer = await seedRaw(t.token, 'Paneer', 5000);
    const filling = (await addPrepItem(t.token, 'Filling').expect(201)).body;
    await setPrepRecipe(t.token, filling.id, 1000, [
      { ingredientId: paneer.id, quantity: 1000 },
    ]).expect(200);
    const cashier = await becomeRole(t, 'CASHIER');

    await addPrepItem(cashier, 'Hack').expect(403);
    await setPrepRecipe(cashier, filling.id, 1000, [
      { ingredientId: paneer.id, quantity: 1 },
    ]).expect(403);
    await prepareBatch(cashier, filling.id, { quantity: 1000 }).expect(403);
    // A cashier cannot even read the prep board (no inventory.read).
    await api().get('/api/v1/prep/items').set(auth(cashier)).expect(403);
  });

  it('isolates prep between tenants', async () => {
    const a = await newTenant('Prep Tenant A');
    const b = await newTenant('Prep Tenant B');
    const paneer = await seedRaw(a.token, 'Paneer', 5000);
    const filling = (await addPrepItem(a.token, 'Filling').expect(201)).body;
    await setPrepRecipe(a.token, filling.id, 1000, [
      { ingredientId: paneer.id, quantity: 1000 },
    ]).expect(200);

    // B does not see A's prep item, and cannot prepare against it.
    expect(
      (await api().get('/api/v1/prep/items').set(auth(b.token)).expect(200))
        .body,
    ).toHaveLength(0);
    await getPrep(b.token, filling.id).expect(404);
    await prepareBatch(b.token, filling.id, { quantity: 1000 }).expect(404);
  });
});
