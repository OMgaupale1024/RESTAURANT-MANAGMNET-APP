/**
 * Customers end-to-end.
 *
 * This table is PII, so the cross-tenant tests carry more weight than
 * anywhere else so far: a leak here is a privacy breach, not a lost recipe.
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

let ipCounter = 400000;
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
  const email = `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Cust Owner' })
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
    .send({ name: 'Momo', priceMinor: 10000 })
    .expect(201);

  return {
    email,
    token,
    restaurantId: created.body.restaurant.id as string,
    productId: product.body.id as string,
  };
}

const addCustomer = (token: string, body: Record<string, unknown>) =>
  api()
    .post('/api/v1/customers')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

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

describe('Customers (e2e)', () => {
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
    ]) {
      await owner.$executeRawUnsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    }
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 'c-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      const rids = ms.map((m) => m.restaurantId);
      // Orders reference customers with onDelete: Restrict, so orders go first.
      await owner.order.deleteMany({ where: { restaurantId: { in: rids } } });
      await owner.customer.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.restaurant.deleteMany({ where: { id: { in: rids } } });
      await owner.securityEvent.deleteMany({
        where: { email: { startsWith: 'c-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 'c-' } } });
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

  describe('creating', () => {
    it('creates a customer', async () => {
      const t = await newTenant('Cust Cafe');
      const res = await addCustomer(t.token, {
        name: 'Asha Patil',
        phone: '9876543210',
      }).expect(201);
      expect(res.body.name).toBe('Asha Patil');
      expect(res.body.phone).toBe('9876543210');
    });

    it('normalises every Indian phone format to the same national number', async () => {
      // Regression: an earlier version stripped non-digits only, so
      // "+91 98765-43210" stored as 919876543210 while "9876543210" stored as
      // itself — one person, two records, and the cashier could not find them.
      for (const [i, input] of [
        '+91 98765-43210',
        '91 98765 43210',
        '098765 43210',
        '98765-43210',
      ].entries()) {
        const t = await newTenant(`Phone Fmt ${i}`);
        const res = await addCustomer(t.token, {
          name: 'Ravi',
          phone: input,
        }).expect(201);
        expect(res.body.phone).toBe('9876543210');
      }
    });

    it('treats differently-formatted versions of a number as the same person', async () => {
      const t = await newTenant('Dup Phone Cafe');
      await addCustomer(t.token, { name: 'A', phone: '9876543210' }).expect(
        201,
      );
      // Same human, typed with a country code. Must collide, not duplicate.
      await addCustomer(t.token, {
        name: 'A again',
        phone: '+91 98765 43210',
      }).expect(409);
    });

    it('finds a customer by phone regardless of how it was typed', async () => {
      const t = await newTenant('Lookup Fmt Cafe');
      await addCustomer(t.token, {
        name: 'Findable',
        phone: '+91 98765 43210',
      }).expect(201);

      // The cashier types it plainly. It must still match.
      const res = await api()
        .get('/api/v1/customers/by-phone/9876543210')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      expect(res.body.name).toBe('Findable');
    });

    it('rejects a phone that is not 7-15 digits', async () => {
      const t = await newTenant('Bad Phone Cafe');
      for (const phone of ['123', 'abcdefgh', '1234567890123456']) {
        await addCustomer(t.token, { name: 'X', phone }).expect(400);
      }
    });

    it('lowercases email', async () => {
      const t = await newTenant('Email Cafe');
      const res = await addCustomer(t.token, {
        name: 'B',
        phone: '9000000001',
        email: 'Mixed.Case@Example.COM',
      }).expect(201);
      expect(res.body.email).toBe('mixed.case@example.com');
    });

    it('rejects a client-supplied restaurantId (mass assignment)', async () => {
      const t = await newTenant('Mass Cafe');
      await addCustomer(t.token, {
        name: 'C',
        phone: '9000000002',
        restaurantId: '00000000-0000-0000-0000-000000000000',
      }).expect(400);
    });

    it('lets two tenants each hold the same phone number', async () => {
      const a = await newTenant('Same Phone A');
      const b = await newTenant('Same Phone B');
      // One person really does eat at two restaurants. Neither may see the
      // other's record, and neither blocks the other.
      await addCustomer(a.token, {
        name: 'Shared',
        phone: '9111111111',
      }).expect(201);
      await addCustomer(b.token, {
        name: 'Shared',
        phone: '9111111111',
      }).expect(201);
    });
  });

  describe('tenant isolation (PII)', () => {
    it("never lists another tenant's customers", async () => {
      const a = await newTenant('Iso A');
      const b = await newTenant('Iso B');
      await addCustomer(a.token, {
        name: 'Private Person',
        phone: '9222222222',
      }).expect(201);

      const res = await api()
        .get('/api/v1/customers')
        .set('Authorization', `Bearer ${b.token}`)
        .expect(200);
      expect(res.body).toHaveLength(0);
    });

    it("cannot read another tenant's customer by id", async () => {
      const a = await newTenant('Read A');
      const b = await newTenant('Read B');
      const c = await addCustomer(a.token, {
        name: 'Target',
        phone: '9333333333',
      }).expect(201);

      await api()
        .get(`/api/v1/customers/${c.body.id}`)
        .set('Authorization', `Bearer ${b.token}`)
        .expect(404);
    });

    it("cannot look up another tenant's customer by phone", async () => {
      const a = await newTenant('Lookup A');
      const b = await newTenant('Lookup B');
      await addCustomer(a.token, {
        name: 'Hidden',
        phone: '9444444444',
      }).expect(201);

      // Phone enumeration: guessing a number must not confirm it belongs to
      // some other restaurant's customer.
      const res = await api()
        .get('/api/v1/customers/by-phone/9444444444')
        .set('Authorization', `Bearer ${b.token}`)
        .expect(200);
      expect(res.body).toEqual({});
    });

    it("cannot edit another tenant's customer", async () => {
      const a = await newTenant('Edit A');
      const b = await newTenant('Edit B');
      const c = await addCustomer(a.token, {
        name: 'Victim',
        phone: '9555555555',
      }).expect(201);

      await api()
        .patch(`/api/v1/customers/${c.body.id}`)
        .set('Authorization', `Bearer ${b.token}`)
        .send({ name: 'Hacked' })
        .expect(404);
    });
  });

  describe('permissions', () => {
    it('a KITCHEN user cannot read customer PII', async () => {
      const t = await newTenant('Kitchen PII Cafe');
      const kitchenToken = await becomeRole(t, 'KITCHEN');
      await api()
        .get('/api/v1/customers')
        .set('Authorization', `Bearer ${kitchenToken}`)
        .expect(403);
    });

    it('a CASHIER can add and look up customers at the till', async () => {
      const t = await newTenant('Cashier Cust Cafe');
      const cashierToken = await becomeRole(t, 'CASHIER');
      await api()
        .post('/api/v1/customers')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ name: 'Walk In', phone: '9666666666' })
        .expect(201);
    });
  });

  describe('orders and stats', () => {
    it('attaches a customer to an order and derives stats', async () => {
      const t = await newTenant('Stats Cafe');
      const c = await addCustomer(t.token, {
        name: 'Regular',
        phone: '9777777777',
      }).expect(201);

      // Two orders: 1 x 10000 + 5% = 10500 each.
      for (let i = 0; i < 2; i++) {
        await api()
          .post('/api/v1/orders')
          .set('Authorization', `Bearer ${t.token}`)
          .send({
            items: [{ productId: t.productId, quantity: 1 }],
            customerId: c.body.id,
            paymentMethod: 'CASH',
          })
          .expect(201);
      }

      const res = await api()
        .get(`/api/v1/customers/${c.body.id}`)
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);

      expect(res.body.stats.visits).toBe(2);
      expect(res.body.stats.totalSpentMinor).toBe(21000);
      expect(res.body.stats.averageBillMinor).toBe(10500);
      expect(res.body.stats.firstVisit).toBeTruthy();
      expect(res.body.recentOrders).toHaveLength(2);
    });

    it('excludes voided orders from spend (a reversed sale did not happen)', async () => {
      const t = await newTenant('Void Stats Cafe');
      const c = await addCustomer(t.token, {
        name: 'Voided',
        phone: '9888888888',
      }).expect(201);

      const keep = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({
          items: [{ productId: t.productId, quantity: 1 }],
          customerId: c.body.id,
        })
        .expect(201);
      const kill = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({
          items: [{ productId: t.productId, quantity: 1 }],
          customerId: c.body.id,
        })
        .expect(201);

      await api()
        .patch(`/api/v1/orders/${kill.body.id}/status`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ status: 'VOIDED', reason: 'mistake' })
        .expect(200);

      const res = await api()
        .get(`/api/v1/customers/${c.body.id}`)
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);

      expect(res.body.stats.visits).toBe(1);
      expect(res.body.stats.totalSpentMinor).toBe(keep.body.totalMinor);
      // The voided order is still visible in history — it happened, it just
      // does not count as spend.
      expect(res.body.recentOrders).toHaveLength(2);
    });

    it("cannot attach another tenant's customer to an order", async () => {
      const a = await newTenant('Attach A');
      const b = await newTenant('Attach B');
      const victim = await addCustomer(a.token, {
        name: 'Not Yours',
        phone: '9999999991',
      }).expect(201);

      await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${b.token}`)
        .send({
          items: [{ productId: b.productId, quantity: 1 }],
          customerId: victim.body.id,
        })
        .expect(400); // "Unknown customer" — existence is not confirmed
    });

    it('leaves anonymous orders anonymous', async () => {
      const t = await newTenant('Anon Cafe');
      const res = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ productId: t.productId, quantity: 1 }] })
        .expect(201);
      expect(res.body.customer).toBeNull();
    });
  });

  describe('search', () => {
    it('finds by partial name and by phone', async () => {
      const t = await newTenant('Search Cafe');
      await addCustomer(t.token, {
        name: 'Priya Sharma',
        phone: '9123456780',
      }).expect(201);
      await addCustomer(t.token, {
        name: 'Rahul Verma',
        phone: '9123456781',
      }).expect(201);

      const byName = await api()
        .get('/api/v1/customers?q=priya')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      expect(byName.body).toHaveLength(1);

      const byPhone = await api()
        .get('/api/v1/customers?q=9123456781')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      expect(byPhone.body).toHaveLength(1);
      expect(byPhone.body[0].name).toBe('Rahul Verma');
    });
  });
});
