/**
 * AI menu scanner end-to-end, against the real database, using the
 * deterministic STUB extractor (the test env sets no MENU_AI_API_KEY, so the
 * whole flow runs with no provider and no spend).
 *
 * What matters here: an extract produces a reviewable, annotated menu; importing
 * writes real catalogue rows the POS then sees; a price change updates rather
 * than duplicates; existing items are never deleted; re-import is refused;
 * sessions are tenant-isolated; and a cashier cannot scan.
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

let ipCounter = 700000;
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

/** A one-pixel PNG data URL. The stub extractor ignores image content. */
const IMG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

async function newTenant(name: string) {
  const email = `mi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Scan Owner' })
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

const extract = (token: string, images: string[] = [IMG]) =>
  api().post('/api/v1/menu-import/extract').set(auth(token)).send({ images });

const addProduct = (token: string, name: string, priceMinor: number) =>
  api().post('/api/v1/products').set(auth(token)).send({ name, priceMinor });

/** Flip the owner's membership to another role and re-login, as procurement.e2e. */
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

describe('Menu import / AI scanner (e2e)', () => {
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
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 'mi-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      const restaurantIds = ms.map((m) => m.restaurantId);
      // menu_import_sessions, products and categories carry no FK to
      // restaurants — clear them explicitly before the restaurant goes.
      await owner.menuImportSession.deleteMany({
        where: { restaurantId: { in: restaurantIds } },
      });
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
        where: { email: { startsWith: 'mi-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 'mi-' } } });
    } finally {
      for (const tbl of [
        'audit_logs',
        'order_events',
        'security_events',
        'orders',
      ]) {
        await owner.$executeRawUnsafe(`ALTER TABLE ${tbl} ENABLE TRIGGER USER`);
      }
      await owner.$disconnect();
    }
    await app.close();
  });

  it('extracts a menu into a reviewable, annotated result', async () => {
    const t = await newTenant('Scan Cafe');
    const res = await extract(t.token).expect(201);

    expect(res.body.status).toBe('REVIEW_REQUIRED');
    expect(res.body.pageCount).toBe(1);
    const menu = res.body.result;
    expect(menu.categories.map((c: { name: string }) => c.name)).toEqual([
      'Momos',
      'Fries',
    ]);

    const veg = menu.categories[0].items[0];
    expect(veg).toMatchObject({
      name: 'Veg Momos',
      priceMinor: 6000, // 60 rupees -> paise, converted server-side
      action: 'create',
    });
    expect(veg.match.kind).toBe('new');

    // The stub includes one low-confidence line for the review UI to flag.
    const peri = menu.categories[1].items.find(
      (i: { name: string }) => i.name === 'Peri Peri Fries',
    );
    expect(peri.confidence).toBeLessThan(0.7);
  });

  it('imports selected items into the catalogue, visible to the POS', async () => {
    const t = await newTenant('Import Cafe');
    const ex = await extract(t.token).expect(201);
    const sessionId = ex.body.id;

    const imp = await api()
      .post(`/api/v1/menu-import/${sessionId}/import`)
      .set(auth(t.token))
      .send({ result: ex.body.result })
      .expect(201);
    expect(imp.body.summary).toMatchObject({ created: 5, updated: 0 });
    expect(imp.body.session.status).toBe('IMPORTED');

    // The POS reads exactly these, in the created categories.
    const products = await api()
      .get('/api/v1/products')
      .set(auth(t.token))
      .expect(200);
    const names = products.body.map((p: { name: string }) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Veg Momos',
        'Paneer Momos',
        'Cheese Momos',
        'Classic Fries',
        'Peri Peri Fries',
      ]),
    );
    const cats = await api()
      .get('/api/v1/categories')
      .set(auth(t.token))
      .expect(200);
    expect(cats.body.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining(['Momos', 'Fries']),
    );

    // One append-only audit row records the import.
    const audit = await owner.auditLog.findMany({
      where: { restaurantId: t.restaurantId, action: 'menu.imported' },
    });
    expect(audit).toHaveLength(1);

    // Re-importing the same session is refused, not silently doubled.
    await api()
      .post(`/api/v1/menu-import/${sessionId}/import`)
      .set(auth(t.token))
      .send({ result: ex.body.result })
      .expect(409);
  });

  it('detects a price change and updates in place rather than duplicating', async () => {
    const t = await newTenant('Reprice Cafe');
    await addProduct(t.token, 'Veg Momos', 5000).expect(201); // existing ₹50

    const ex = await extract(t.token).expect(201);
    const veg = ex.body.result.categories[0].items.find(
      (i: { name: string }) => i.name === 'Veg Momos',
    );
    expect(veg.match.kind).toBe('price_change');
    expect(veg.match.existingPriceMinor).toBe(5000);
    expect(veg.priceMinor).toBe(6000);
    expect(veg.action).toBe('update');

    const imp = await api()
      .post(`/api/v1/menu-import/${ex.body.id}/import`)
      .set(auth(t.token))
      .send({ result: ex.body.result })
      .expect(201);
    expect(imp.body.summary.updated).toBeGreaterThanOrEqual(1);

    // Still exactly one 'Veg Momos', now repriced — no duplicate.
    const products = await api()
      .get('/api/v1/products?include=all')
      .set(auth(t.token))
      .expect(200);
    const vegs = products.body.filter(
      (p: { name: string }) => p.name === 'Veg Momos',
    );
    expect(vegs).toHaveLength(1);
    expect(vegs[0].priceMinor).toBe(6000);
  });

  it('never deletes an existing item that the scan did not mention', async () => {
    const t = await newTenant('Keep Cafe');
    await addProduct(t.token, 'Old Special', 9900).expect(201);

    const ex = await extract(t.token).expect(201);
    await api()
      .post(`/api/v1/menu-import/${ex.body.id}/import`)
      .set(auth(t.token))
      .send({ result: ex.body.result })
      .expect(201);

    const products = await api()
      .get('/api/v1/products?include=all')
      .set(auth(t.token))
      .expect(200);
    expect(
      products.body.some((p: { name: string }) => p.name === 'Old Special'),
    ).toBe(true);
  });

  it('saves a draft and resumes it', async () => {
    const t = await newTenant('Draft Cafe');
    const ex = await extract(t.token).expect(201);
    const menu = ex.body.result;
    // Deselect everything in Fries.
    menu.categories[1].items.forEach(
      (i: { action: string }) => (i.action = 'skip'),
    );
    await api()
      .patch(`/api/v1/menu-import/${ex.body.id}`)
      .set(auth(t.token))
      .send({ result: menu })
      .expect(200);

    const resumed = await api()
      .get(`/api/v1/menu-import/${ex.body.id}`)
      .set(auth(t.token))
      .expect(200);
    const friesActions = resumed.body.result.categories[1].items.map(
      (i: { action: string }) => i.action,
    );
    expect(friesActions.every((a: string) => a === 'skip')).toBe(true);
  });

  it('isolates sessions by tenant, for read and for import', async () => {
    const a = await newTenant('Tenant A');
    const b = await newTenant('Tenant B');
    const ex = await extract(a.token).expect(201);
    // B cannot read A's session (RLS makes it a plain 404)...
    await api()
      .get(`/api/v1/menu-import/${ex.body.id}`)
      .set(auth(b.token))
      .expect(404);
    // ...nor import it into B's catalogue.
    await api()
      .post(`/api/v1/menu-import/${ex.body.id}/import`)
      .set(auth(b.token))
      .send({ result: ex.body.result })
      .expect(404);
    // A's session is untouched and still importable by A.
    await api()
      .post(`/api/v1/menu-import/${ex.body.id}/import`)
      .set(auth(a.token))
      .send({ result: ex.body.result })
      .expect(201);
  });

  it('extracts from multiple pages into one session', async () => {
    const t = await newTenant('Pages Cafe');
    const res = await extract(t.token, [IMG, IMG, IMG]).expect(201);
    expect(res.body.pageCount).toBe(3);
    // The stub merges to one menu — pages do not multiply the item list.
    const names = res.body.result.categories.flatMap(
      (c: { items: { name: string }[] }) => c.items.map((i) => i.name),
    );
    expect(names.filter((n: string) => n === 'Veg Momos')).toHaveLength(1);
  });

  it('forbids a cashier from scanning', async () => {
    const t = await newTenant('Role Cafe');
    const cashier = await becomeRole(t, 'CASHIER');
    await api()
      .post('/api/v1/menu-import/extract')
      .set(auth(cashier))
      .send({ images: [IMG] })
      .expect(403);
  });

  it('forbids kitchen from scanning', async () => {
    const t = await newTenant('Kitchen Cafe');
    const kitchen = await becomeRole(t, 'KITCHEN');
    await api()
      .post('/api/v1/menu-import/extract')
      .set(auth(kitchen))
      .send({ images: [IMG] })
      .expect(403);
  });

  it('rejects an unsupported file type and an empty request', async () => {
    const t = await newTenant('Guard Cafe');
    await extract(t.token, ['data:application/pdf;base64,AAAA']).expect(400);
    await extract(t.token, []).expect(400);
  });
});
