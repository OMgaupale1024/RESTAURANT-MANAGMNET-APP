/**
 * Restaurant setup end-to-end, against the real database.
 *
 * The important tests here are the cross-tenant ones: this step is where a
 * client first sends a restaurantId, so it is where a tenant boundary can
 * first be broken.
 */
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaPg } from '@prisma/adapter-pg';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaClient } from '../src/generated/prisma/client';

const password = 'correct-horse-battery';

let app: NestExpressApplication;
let prisma: PrismaService;

/**
 * Owner connection, for setup and teardown only.
 *
 * PrismaService connects as oraos_api, which RLS applies to — so it cannot see
 * or modify another tenant's rows even in a test. Using it for teardown means
 * the deletes silently do nothing. The owner role has BYPASSRLS, which is
 * exactly why the app must never use it and why a test fixture may.
 */
const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// Unique IP per request so the real rate limiter never trips. See
// auth.e2e-spec.ts — the limiter stays on.
let ipCounter = 100000;
function api() {
  ipCounter++;
  const ip = `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
  const server = app.getHttpServer();
  return {
    post: (url: string) => request(server).post(url).set('X-Forwarded-For', ip),
    get: (url: string) => request(server).get(url).set('X-Forwarded-For', ip),
  };
}

/** Registers a fresh user and returns their access token. */
async function newUser(): Promise<{ token: string; email: string }> {
  const email = `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Owner' })
    .expect(201);
  return { token: res.body.accessToken, email };
}

/** Decodes a JWT payload without verifying — test-only inspection. */
function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
}

describe('Restaurants (e2e)', () => {
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
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // Restaurants cannot be hard-deleted while audit history exists — the
    // append-only triggers refuse. Disable them, exactly as the documented
    // purge procedure does. DDL requires the owner; the app role cannot.
    await owner.$executeRawUnsafe(
      `ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only`,
    );
    await owner.$executeRawUnsafe(
      `ALTER TABLE security_events DISABLE TRIGGER security_events_append_only`,
    );
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 'r-' } },
        select: { id: true },
      });
      const ids = users.map((u) => u.id);
      const ms = await owner.membership.findMany({
        where: { userId: { in: ids } },
        select: { restaurantId: true },
      });
      await owner.restaurant.deleteMany({
        where: { id: { in: ms.map((m) => m.restaurantId) } },
      });
      await owner.securityEvent.deleteMany({
        where: { email: { startsWith: 'r-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 'r-' } } });
    } finally {
      await owner.$executeRawUnsafe(
        `ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only`,
      );
      await owner.$executeRawUnsafe(
        `ALTER TABLE security_events ENABLE TRIGGER security_events_append_only`,
      );
      await owner.$disconnect();
    }
    await app.close();
  });

  describe('create', () => {
    it('creates restaurant, first branch and OWNER membership atomically', async () => {
      const { token } = await newUser();
      const res = await api()
        .post('/api/v1/restaurants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Momo Palace', branchName: 'MG Road' })
        .expect(201);

      expect(res.body.restaurant.name).toBe('Momo Palace');
      expect(res.body.restaurant.slug).toBe('momo-palace');
      expect(res.body.branch.name).toBe('MG Road');
      expect(res.body.membershipId).toBeDefined();
    });

    it('defaults the first branch to "Main"', async () => {
      const { token } = await newUser();
      const res = await api()
        .post('/api/v1/restaurants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Solo Kitchen' })
        .expect(201);
      expect(res.body.branch.name).toBe('Main');
    });

    it('writes the creation to the tenant audit log', async () => {
      const { token } = await newUser();
      const res = await api()
        .post('/api/v1/restaurants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Audited Diner' })
        .expect(201);

      const id = res.body.restaurant.id;
      const logs = await prisma.txAs({ userId: '', restaurantId: id }, (db) =>
        db.auditLog.findMany({ where: { restaurantId: id } }),
      );
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe('restaurant.created');
    });

    it('rejects an unauthenticated create', () =>
      api().post('/api/v1/restaurants').send({ name: 'Ghost' }).expect(401));

    it('rejects a too-short name', async () => {
      const { token } = await newUser();
      await api()
        .post('/api/v1/restaurants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'x' })
        .expect(400);
    });

    it('rejects a client-supplied id (mass assignment)', async () => {
      const { token } = await newUser();
      await api()
        .post('/api/v1/restaurants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Forged', id: '00000000-0000-0000-0000-000000000000' })
        .expect(400);
    });

    it('gives colliding names distinct slugs', async () => {
      const a = await newUser();
      const b = await newUser();
      const r1 = await api()
        .post('/api/v1/restaurants')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ name: 'Same Name Cafe' })
        .expect(201);
      const r2 = await api()
        .post('/api/v1/restaurants')
        .set('Authorization', `Bearer ${b.token}`)
        .send({ name: 'Same Name Cafe' })
        .expect(201);
      expect(r1.body.restaurant.slug).not.toBe(r2.body.restaurant.slug);
    });
  });

  describe('select-restaurant (tenant boundary)', () => {
    it('issues a token carrying the restaurant and owner permissions', async () => {
      const { token } = await newUser();
      const created = await api()
        .post('/api/v1/restaurants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Claims Cafe' })
        .expect(201);

      // The registration token has no restaurant.
      expect(claims(token).rid).toBeNull();

      const res = await api()
        .post('/api/v1/auth/select-restaurant')
        .set('Authorization', `Bearer ${token}`)
        .send({ restaurantId: created.body.restaurant.id })
        .expect(200);

      const c = claims(res.body.accessToken);
      expect(c.rid).toBe(created.body.restaurant.id);
      expect(c.role).toBe('OWNER');
      expect(c.perms).toContain('order.refund');
    });

    it('continues the same token family and leaves no live orphan', async () => {
      // Regression test for a real bug: select-restaurant used to mint a NEW
      // family, orphaning the login token. It stayed valid for 7 days and
      // survived logout, because logout only revokes the cookie's current
      // token. One session must mean one family.
      const email = `r-fam-${Date.now()}@example.com`;
      const reg = await api()
        .post('/api/v1/auth/register')
        .send({ email, password, name: 'Fam' })
        .expect(201);
      const token = reg.body.accessToken;
      const cookie = reg.headers['set-cookie'][0].split(';')[0];

      const created = await api()
        .post('/api/v1/restaurants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Family Cafe' })
        .expect(201);

      await api()
        .post('/api/v1/auth/select-restaurant')
        .set('Authorization', `Bearer ${token}`)
        .set('Cookie', cookie)
        .send({ restaurantId: created.body.restaurant.id })
        .expect(200);

      const user = await owner.user.findUnique({ where: { email } });
      const tokens = await owner.refreshToken.findMany({
        where: { userId: user!.id },
      });

      expect(new Set(tokens.map((t) => t.familyId)).size).toBe(1);
      expect(tokens.filter((t) => !t.revokedAt)).toHaveLength(1);
    });

    it("refuses to select another user's restaurant", async () => {
      const victim = await newUser();
      const attacker = await newUser();

      const victimRestaurant = await api()
        .post('/api/v1/restaurants')
        .set('Authorization', `Bearer ${victim.token}`)
        .send({ name: 'Victim Bistro' })
        .expect(201);

      // The whole attack: a valid token plus someone else's restaurant id.
      await api()
        .post('/api/v1/auth/select-restaurant')
        .set('Authorization', `Bearer ${attacker.token}`)
        .send({ restaurantId: victimRestaurant.body.restaurant.id })
        .expect(403);
    });

    it('refuses a restaurant that does not exist, identically to one it cannot access', async () => {
      const { token } = await newUser();
      await api()
        .post('/api/v1/auth/select-restaurant')
        .set('Authorization', `Bearer ${token}`)
        .send({ restaurantId: '00000000-0000-0000-0000-000000000000' })
        .expect(403); // not 404 — existence must not leak
    });

    it('rejects a non-uuid restaurantId', async () => {
      const { token } = await newUser();
      await api()
        .post('/api/v1/auth/select-restaurant')
        .set('Authorization', `Bearer ${token}`)
        .send({ restaurantId: 'not-a-uuid' })
        .expect(400);
    });

    it('refuses selection once membership is deactivated', async () => {
      const { token } = await newUser();
      const created = await api()
        .post('/api/v1/restaurants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Revoked Grill' })
        .expect(201);

      // Owner connection: RLS would silently block this via the app role,
      // leaving the membership active and the test passing for the wrong reason.
      await owner.membership.updateMany({
        where: { restaurantId: created.body.restaurant.id },
        data: { isActive: false },
      });

      await api()
        .post('/api/v1/auth/select-restaurant')
        .set('Authorization', `Bearer ${token}`)
        .send({ restaurantId: created.body.restaurant.id })
        .expect(403);
    });
  });

  describe('list', () => {
    it("lists only the caller's restaurants", async () => {
      const a = await newUser();
      const b = await newUser();

      await api()
        .post('/api/v1/restaurants')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ name: 'A Cafe' })
        .expect(201);
      await api()
        .post('/api/v1/restaurants')
        .set('Authorization', `Bearer ${b.token}`)
        .send({ name: 'B Cafe' })
        .expect(201);

      const res = await api()
        .get('/api/v1/restaurants')
        .set('Authorization', `Bearer ${a.token}`)
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].restaurant.name).toBe('A Cafe');
      expect(res.body[0].role.key).toBe('OWNER');
    });
  });

  describe('security events (backlog #3)', () => {
    it('records a successful login', async () => {
      const { email } = await newUser();
      await api()
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200);

      const events = await owner.securityEvent.findMany({ where: { email } });
      const types = events.map((e) => e.type);
      expect(types).toContain('REGISTERED');
      expect(types).toContain('LOGIN_SUCCESS');
    });

    it('records a failed login for an email that does not exist', async () => {
      const ghost = `r-ghost-${Date.now()}@example.com`;
      await api()
        .post('/api/v1/auth/login')
        .send({ email: ghost, password: 'wrong-password-here' })
        .expect(401);

      // Give the fire-and-forget write a moment.
      await new Promise((r) => setTimeout(r, 600));

      const events = await owner.securityEvent.findMany({
        where: { email: ghost },
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('LOGIN_FAILED');
      expect(events[0].userId).toBeNull();
      // The reason is kept server-side even though the client is told nothing.
      expect((events[0].metadata as { reason: string }).reason).toBe(
        'unknown_email',
      );
    });

    it('cannot be tampered with (append-only)', async () => {
      const { email } = await newUser();
      const ev = await owner.securityEvent.findFirst({ where: { email } });
      await expect(
        prisma.securityEvent.delete({ where: { id: ev!.id } }),
      ).rejects.toThrow();
    });
  });
});
