/**
 * Combos & upsells end-to-end, against the real database.
 *
 * What matters here: a combo is sold as ONE line at its OWN price (never the
 * component sum, so analytics count it once), the components are snapshotted so
 * history never re-prices, only a manager configures, upsell rules reject
 * self/loop/duplicate, and everything is tenant-isolated.
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

let ipCounter = 840000;
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
  const email = `combo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Combo Owner' })
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

const createCombo = (token: string, body: Record<string, unknown>) =>
  api().post('/api/v1/combos').set(auth(token)).send(body);

const placeOrder = (token: string, items: unknown[]) =>
  api()
    .post('/api/v1/orders')
    .set(auth(token))
    .send({ items, orderType: 'TAKEAWAY', paymentMethod: 'CASH' });

/** A Veg Momos (₹60) + Cold Drink (₹40) combo at its own ₹85 price. */
async function seedVegCombo(token: string) {
  const momo = (
    await addProduct(token, `Veg Momos ${Math.random()}`, 6000).expect(201)
  ).body;
  const coke = (
    await addProduct(token, `Cold Drink ${Math.random()}`, 4000).expect(201)
  ).body;
  const combo = (
    await createCombo(token, {
      name: `Veg Momos Combo ${Math.random()}`,
      priceMinor: 8500,
      items: [
        { productId: momo.id, quantity: 1 },
        { productId: coke.id, quantity: 1 },
      ],
    }).expect(201)
  ).body;
  return { momo, coke, combo };
}

describe('Combos & upsells (e2e)', () => {
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

  it('creates a combo of existing products and lists it as available', async () => {
    const t = await newTenant('Combo Config');
    const { momo, coke, combo } = await seedVegCombo(t.token);

    expect(combo.priceMinor).toBe(8500);
    expect(combo.available).toBe(true);
    expect(
      combo.items.map((i: { productId: string }) => i.productId).sort(),
    ).toEqual([momo.id, coke.id].sort());

    const list = await api()
      .get('/api/v1/combos')
      .set(auth(t.token))
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(combo.id);
  });

  it('bills the combo price once (not the component sum) and snapshots components', async () => {
    const t = await newTenant('Combo Price');
    const { momo, coke, combo } = await seedVegCombo(t.token);

    const order = (
      await placeOrder(t.token, [{ comboId: combo.id, quantity: 2 }]).expect(
        201,
      )
    ).body;

    const line = order.items[0];
    expect(line.productId).toBeNull();
    expect(line.unitPriceMinor).toBe(8500); // the combo's own price
    expect(line.lineTotalMinor).toBe(17000); // × 2 — NOT 2 × (6000 + 4000)
    expect(order.subtotalMinor).toBe(17000);
    expect(order.taxMinor).toBe(850); // 5% of 17000
    // The order total is what analytics sum — combo counted once, at ₹85 each.
    expect(order.totalMinor).toBe(17850);
    expect(line.comboItems).toEqual([
      expect.objectContaining({ productId: momo.id, quantity: 1 }),
      expect.objectContaining({ productId: coke.id, quantity: 1 }),
    ]);
  });

  it('keeps the OLD price on a past order after the combo is repriced', async () => {
    const t = await newTenant('Combo History');
    const { combo } = await seedVegCombo(t.token);

    const order = (
      await placeOrder(t.token, [{ comboId: combo.id, quantity: 1 }]).expect(
        201,
      )
    ).body;
    expect(order.items[0].unitPriceMinor).toBe(8500);

    // Owner raises the combo to ₹95.
    await api()
      .patch(`/api/v1/combos/${combo.id}`)
      .set(auth(t.token))
      .send({ priceMinor: 9500 })
      .expect(200);

    const reread = await api()
      .get(`/api/v1/orders/${order.id}`)
      .set(auth(t.token))
      .expect(200);
    expect(reread.body.items[0].unitPriceMinor).toBe(8500); // still the sold price
  });

  it('blocks selling a combo whose component was deactivated', async () => {
    const t = await newTenant('Combo Unavailable');
    const { coke, combo } = await seedVegCombo(t.token);

    await api()
      .patch(`/api/v1/products/${coke.id}`)
      .set(auth(t.token))
      .send({ isActive: false })
      .expect(200);

    // Management still sees it, now flagged unavailable...
    const list = await api()
      .get('/api/v1/combos?include=all')
      .set(auth(t.token))
      .expect(200);
    expect(list.body[0].available).toBe(false);
    // ...but it cannot be ordered.
    await placeOrder(t.token, [{ comboId: combo.id, quantity: 1 }]).expect(400);
  });

  it('rejects a line that is both a product and a combo, or a combo with modifiers', async () => {
    const t = await newTenant('Combo Xor');
    const { momo, combo } = await seedVegCombo(t.token);

    // Both ids on one line.
    await placeOrder(t.token, [
      { productId: momo.id, comboId: combo.id, quantity: 1 },
    ]).expect(400);
    // Neither id.
    await placeOrder(t.token, [{ quantity: 1 }]).expect(400);
    // A combo does not take modifiers.
    await placeOrder(t.token, [
      { comboId: combo.id, quantity: 1, modifierOptionIds: [momo.id] },
    ]).expect(400);
  });

  it('lets a cashier SELL combos but never CONFIGURE them', async () => {
    const t = await newTenant('Combo Perms');
    const { momo, combo } = await seedVegCombo(t.token);
    const cashier = await becomeRole(t, 'CASHIER');

    // Cashier can ring up the combo and read the list.
    await placeOrder(cashier, [{ comboId: combo.id, quantity: 1 }]).expect(201);
    await api().get('/api/v1/combos').set(auth(cashier)).expect(200);

    // But cannot create, edit or delete a definition or an upsell rule.
    await createCombo(cashier, {
      name: 'Hack Combo',
      priceMinor: 100,
      items: [{ productId: momo.id, quantity: 1 }],
    }).expect(403);
    await api()
      .patch(`/api/v1/combos/${combo.id}`)
      .set(auth(cashier))
      .send({ priceMinor: 1 })
      .expect(403);
    await api()
      .delete(`/api/v1/combos/${combo.id}`)
      .set(auth(cashier))
      .expect(403);
    await api()
      .post('/api/v1/upsell-rules')
      .set(auth(cashier))
      .send({ triggerProductId: momo.id, suggestedProductId: momo.id })
      .expect(403);
  });

  it('isolates combos between tenants', async () => {
    const a = await newTenant('Combo Tenant A');
    const b = await newTenant('Combo Tenant B');
    const seedA = await seedVegCombo(a.token);

    // B does not see A's combo.
    const listB = await api()
      .get('/api/v1/combos')
      .set(auth(b.token))
      .expect(200);
    expect(listB.body).toHaveLength(0);
    // B cannot edit or delete A's combo (not found under B's tenant).
    await api()
      .patch(`/api/v1/combos/${seedA.combo.id}`)
      .set(auth(b.token))
      .send({ name: 'Hijacked' })
      .expect(404);
    // B cannot order A's combo (simply unavailable for B).
    await placeOrder(b.token, [
      { comboId: seedA.combo.id, quantity: 1 },
    ]).expect(400);
  });

  it('configures upsell rules and refuses self, loop and duplicate', async () => {
    const t = await newTenant('Combo Upsell');
    const momo = (
      await addProduct(t.token, `Momo ${Math.random()}`, 6000).expect(201)
    ).body;
    const coke = (
      await addProduct(t.token, `Coke ${Math.random()}`, 3000).expect(201)
    ).body;

    // A product cannot upsell itself.
    await api()
      .post('/api/v1/upsell-rules')
      .set(auth(t.token))
      .send({ triggerProductId: momo.id, suggestedProductId: momo.id })
      .expect(400);

    // Momo → Coke is fine, and the list resolves both names.
    await api()
      .post('/api/v1/upsell-rules')
      .set(auth(t.token))
      .send({ triggerProductId: momo.id, suggestedProductId: coke.id })
      .expect(201);
    const rules = await api()
      .get('/api/v1/upsell-rules')
      .set(auth(t.token))
      .expect(200);
    expect(rules.body).toHaveLength(1);
    expect(rules.body[0].suggestedProduct.name).toBe(coke.name);

    // The reverse (Coke → Momo) would loop — rejected.
    await api()
      .post('/api/v1/upsell-rules')
      .set(auth(t.token))
      .send({ triggerProductId: coke.id, suggestedProductId: momo.id })
      .expect(400);

    // The exact same rule again — rejected as a duplicate.
    await api()
      .post('/api/v1/upsell-rules')
      .set(auth(t.token))
      .send({ triggerProductId: momo.id, suggestedProductId: coke.id })
      .expect(409);
  });
});
