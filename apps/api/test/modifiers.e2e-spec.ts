/**
 * Product modifiers end-to-end, against the real database.
 *
 * What matters here: the server owns the price (a client cannot dictate a
 * modifier's cost), selection rules are enforced server-side, what was ordered
 * is snapshotted so history never re-prices, only a manager configures, and
 * modifiers are tenant-isolated.
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

let ipCounter = 820000;
function api() {
  ipCounter++;
  const ip = `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
  const server = app.getHttpServer();
  return {
    post: (url: string) => request(server).post(url).set('X-Forwarded-For', ip),
    get: (url: string) => request(server).get(url).set('X-Forwarded-For', ip),
    patch: (url: string) =>
      request(server).patch(url).set('X-Forwarded-For', ip),
    delete: (url: string) =>
      request(server).delete(url).set('X-Forwarded-For', ip),
  };
}

async function newTenant(name: string) {
  const email = `mod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Mod Owner' })
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

/** Flip the owner's membership to another role and re-login. */
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

const addProduct = (token: string, name: string, priceMinor: number) =>
  api().post('/api/v1/products').set(auth(token)).send({ name, priceMinor });

const addGroup = (
  token: string,
  productId: string,
  body: Record<string, unknown>,
) =>
  api()
    .post(`/api/v1/products/${productId}/modifier-groups`)
    .set(auth(token))
    .send(body);

const addOption = (
  token: string,
  groupId: string,
  body: Record<string, unknown>,
) =>
  api()
    .post(`/api/v1/modifier-groups/${groupId}/options`)
    .set(auth(token))
    .send(body);

/** A product (₹60) with a required Style group and an optional Add-ons group. */
async function seedMomos(token: string) {
  const product = (
    await addProduct(token, `Veg Momos ${Math.random()}`, 6000).expect(201)
  ).body;
  const style = (
    await addGroup(token, product.id, {
      name: 'Style',
      minSelect: 1,
      maxSelect: 1,
    }).expect(201)
  ).body;
  const steamed = (
    await addOption(token, style.id, { name: 'Steamed' }).expect(201)
  ).body;
  const tandoori = (
    await addOption(token, style.id, {
      name: 'Tandoori',
      priceAdjustMinor: 2000,
    }).expect(201)
  ).body;
  const addons = (
    await addGroup(token, product.id, {
      name: 'Add-ons',
      minSelect: 0,
      maxSelect: 2,
    }).expect(201)
  ).body;
  const chutney = (
    await addOption(token, addons.id, {
      name: 'Extra Chutney',
      priceAdjustMinor: 1000,
    }).expect(201)
  ).body;
  return { product, style, steamed, tandoori, addons, chutney };
}

const placeOrder = (token: string, items: unknown[]) =>
  api()
    .post('/api/v1/orders')
    .set(auth(token))
    .send({ items, orderType: 'TAKEAWAY', paymentMethod: 'CASH' });

describe('Product modifiers (e2e)', () => {
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
    await app.close();
    await owner.$disconnect();
  });

  it('configures groups + options and embeds active ones on the product', async () => {
    const t = await newTenant('Mod Config');
    const { product, style } = await seedMomos(t.token);

    const groups = await api()
      .get(`/api/v1/products/${product.id}/modifier-groups`)
      .set(auth(t.token))
      .expect(200);
    expect(groups.body).toHaveLength(2);
    expect(groups.body[0]).toMatchObject({
      name: 'Style',
      minSelect: 1,
      maxSelect: 1,
    });

    // The POS product list carries the active config, no extra fetch.
    const products = await api()
      .get('/api/v1/products')
      .set(auth(t.token))
      .expect(200);
    const p = products.body.find((x: { id: string }) => x.id === product.id);
    expect(p.modifierGroups).toHaveLength(2);
    expect(
      p.modifierGroups.find((g: { id: string }) => g.id === style.id).options,
    ).toHaveLength(2);
  });

  it('prices modifiers server-side and snapshots them on the line', async () => {
    const t = await newTenant('Mod Price');
    const { product, tandoori, chutney } = await seedMomos(t.token);

    const order = (
      await placeOrder(t.token, [
        {
          productId: product.id,
          quantity: 2,
          modifierOptionIds: [tandoori.id, chutney.id],
        },
      ]).expect(201)
    ).body;

    const line = order.items[0];
    expect(line.unitPriceMinor).toBe(9000); // 6000 + 2000 + 1000
    expect(line.lineTotalMinor).toBe(18000); // × 2
    expect(order.subtotalMinor).toBe(18000);
    expect(order.taxMinor).toBe(900); // 5% of 18000
    expect(order.totalMinor).toBe(18900);
    expect(line.modifiers).toEqual([
      expect.objectContaining({
        optionName: 'Tandoori',
        priceAdjustMinor: 2000,
      }),
      expect.objectContaining({
        optionName: 'Extra Chutney',
        priceAdjustMinor: 1000,
      }),
    ]);
  });

  it('rejects a missing required group, too many, and cross-product / inactive options', async () => {
    const t = await newTenant('Mod Rules');
    const { product, steamed, tandoori, chutney } = await seedMomos(t.token);

    // Required Style not chosen.
    await placeOrder(t.token, [
      { productId: product.id, quantity: 1, modifierOptionIds: [chutney.id] },
    ]).expect(400);

    // Two from a single-select group.
    await placeOrder(t.token, [
      {
        productId: product.id,
        quantity: 1,
        modifierOptionIds: [steamed.id, tandoori.id],
      },
    ]).expect(400);

    // An option from a DIFFERENT product.
    const other = await seedMomos(t.token);
    await placeOrder(t.token, [
      {
        productId: product.id,
        quantity: 1,
        modifierOptionIds: [steamed.id, other.chutney.id],
      },
    ]).expect(400);

    // A deactivated option can no longer be ordered.
    await api()
      .patch(`/api/v1/modifier-options/${steamed.id}`)
      .set(auth(t.token))
      .send({ isActive: false })
      .expect(200);
    await placeOrder(t.token, [
      { productId: product.id, quantity: 1, modifierOptionIds: [steamed.id] },
    ]).expect(400);
    // Style still orderable via its other (active) option.
    await placeOrder(t.token, [
      { productId: product.id, quantity: 1, modifierOptionIds: [tandoori.id] },
    ]).expect(201);
  });

  it('keeps the OLD price on a past order after the modifier is repriced', async () => {
    const t = await newTenant('Mod History');
    const { product, steamed, chutney } = await seedMomos(t.token);

    const order = (
      await placeOrder(t.token, [
        {
          productId: product.id,
          quantity: 1,
          modifierOptionIds: [steamed.id, chutney.id],
        },
      ]).expect(201)
    ).body;
    expect(order.items[0].unitPriceMinor).toBe(7000); // 6000 + 1000

    // Chutney goes up to ₹15.
    await api()
      .patch(`/api/v1/modifier-options/${chutney.id}`)
      .set(auth(t.token))
      .send({ priceAdjustMinor: 1500 })
      .expect(200);

    const reread = await api()
      .get(`/api/v1/orders/${order.id}`)
      .set(auth(t.token))
      .expect(200);
    expect(reread.body.items[0].unitPriceMinor).toBe(7000);
    expect(
      reread.body.items[0].modifiers.find(
        (m: { optionName: string }) => m.optionName === 'Extra Chutney',
      ).priceAdjustMinor,
    ).toBe(1000); // still the sold-at price, not 1500
  });

  it('lets a cashier SELECT modifiers but never CONFIGURE them', async () => {
    const t = await newTenant('Mod Perms');
    const { product, style, steamed } = await seedMomos(t.token);
    const cashier = await becomeRole(t, 'CASHIER');

    // Cashier can ring up an order with modifiers.
    await placeOrder(cashier, [
      { productId: product.id, quantity: 1, modifierOptionIds: [steamed.id] },
    ]).expect(201);

    // But cannot create, edit or delete a definition.
    await addGroup(cashier, product.id, {
      name: 'Hack',
      minSelect: 0,
      maxSelect: 1,
    }).expect(403);
    await addOption(cashier, style.id, {
      name: 'Free',
      priceAdjustMinor: 0,
    }).expect(403);
    await api()
      .patch(`/api/v1/modifier-options/${steamed.id}`)
      .set(auth(cashier))
      .send({ priceAdjustMinor: 0 })
      .expect(403);
    await api()
      .delete(`/api/v1/modifier-groups/${style.id}`)
      .set(auth(cashier))
      .expect(403);
  });

  it('isolates modifiers between tenants', async () => {
    const a = await newTenant('Mod Tenant A');
    const b = await newTenant('Mod Tenant B');
    const seedA = await seedMomos(a.token);
    const prodB = (await addProduct(b.token, 'B Momos', 5000).expect(201)).body;

    // B cannot see, edit or delete A's group.
    await api()
      .get(`/api/v1/products/${seedA.product.id}/modifier-groups`)
      .set(auth(b.token))
      .expect(404);
    await api()
      .patch(`/api/v1/modifier-groups/${seedA.style.id}`)
      .set(auth(b.token))
      .send({ name: 'Hijacked' })
      .expect(404);

    // B cannot order using A's option id (it simply is not found for B).
    await placeOrder(b.token, [
      {
        productId: prodB.id,
        quantity: 1,
        modifierOptionIds: [seedA.steamed.id],
      },
    ]).expect(400);
  });
});
