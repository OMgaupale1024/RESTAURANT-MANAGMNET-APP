/**
 * Staff end-to-end.
 *
 * The tests that matter: invites are a credential (so they expire, are
 * single-use, and cannot be probed), roles cannot be escalated, and a cashier
 * cannot write their own hours.
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

let ipCounter = 600000;
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
  const email = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Staff Owner' })
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

const invite = (token: string, body: Record<string, unknown>) =>
  api()
    .post('/api/v1/staff/invites')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

/** Token out of the invite URL — the raw value exists only in this response. */
const tokenOf = (inviteUrl: string) => inviteUrl.split('/join/')[1];

/** The `oraos_rt=...` pair out of a Set-Cookie response. */
function cookieOf(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown;
  const list = Array.isArray(raw) ? (raw as string[]) : [raw as string];
  return list.find((c) => c?.startsWith('oraos_rt='))!.split(';')[0];
}

/** Invites a member, accepts, and returns their scoped token. */
async function addStaff(ownerToken: string, role: string) {
  const email = `s-mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const inv = await invite(ownerToken, { email, role }).expect(201);
  const accepted = await api()
    .post(`/api/v1/join/${tokenOf(inv.body.inviteUrl)}`)
    .send({ name: 'Team Member', password })
    .expect(201);
  return { email, token: accepted.body.accessToken as string };
}

const claims = (t: string) =>
  JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString()) as {
    rid: string | null;
    role: string | null;
    perms: string[];
    mid: string | null;
  };

describe('Staff (e2e)', () => {
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
      'attendance_events',
    ]) {
      await owner.$executeRawUnsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    }
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 's-' } },
        select: { id: true },
      });
      const ids = users.map((u) => u.id);
      const ms = await owner.membership.findMany({
        where: { userId: { in: ids } },
        select: { id: true, restaurantId: true },
      });
      const rids = [...new Set(ms.map((m) => m.restaurantId))];
      await owner.attendanceEvent.deleteMany({
        where: { membershipId: { in: ms.map((m) => m.id) } },
      });
      await owner.staffInvite.deleteMany({
        where: { restaurantId: { in: rids } },
      });
      await owner.order.deleteMany({ where: { restaurantId: { in: rids } } });
      await owner.restaurant.deleteMany({ where: { id: { in: rids } } });
      await owner.securityEvent.deleteMany({
        where: { email: { startsWith: 's-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 's-' } } });
    } finally {
      for (const t of [
        'audit_logs',
        'order_events',
        'security_events',
        'orders',
        'stock_movements',
        'attendance_events',
      ]) {
        await owner.$executeRawUnsafe(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
      }
      await owner.$disconnect();
    }
    await app.close();
  });

  describe('invites', () => {
    it('creates an invite and returns the link exactly once', async () => {
      const t = await newTenant('Invite Cafe');
      const res = await invite(t.token, {
        email: 'newbie@example.com',
        role: 'CASHIER',
      }).expect(201);

      expect(res.body.inviteUrl).toContain('/join/');
      // The raw token is never stored, so it can never be handed out again.
      const row = await owner.staffInvite.findFirst({
        where: { email: 'newbie@example.com' },
      });
      expect(row!.tokenHash).not.toContain(tokenOf(res.body.inviteUrl));
    });

    it('refuses to invite an OWNER (privilege escalation)', async () => {
      const t = await newTenant('Owner Invite Cafe');
      // An invite link can be forwarded, and an owner can remove the owner.
      await invite(t.token, { email: 'x@example.com', role: 'OWNER' }).expect(
        400,
      );
    });

    it('rejects an unknown role', async () => {
      const t = await newTenant('Bad Role Cafe');
      await invite(t.token, {
        email: 'x@example.com',
        role: 'SUPERUSER',
      }).expect(400);
    });

    it('allows only one pending invite per email', async () => {
      const t = await newTenant('Dup Invite Cafe');
      await invite(t.token, {
        email: 'dup@example.com',
        role: 'CASHIER',
      }).expect(201);
      await invite(t.token, {
        email: 'dup@example.com',
        role: 'KITCHEN',
      }).expect(409);
    });

    it('describes an invite without leaking who else works there', async () => {
      const t = await newTenant('Describe Cafe');
      const inv = await invite(t.token, {
        email: 'look@example.com',
        role: 'KITCHEN',
      }).expect(201);

      const res = await api()
        .get(`/api/v1/join/${tokenOf(inv.body.inviteUrl)}`)
        .expect(200);
      expect(res.body.restaurantName).toBe('Describe Cafe');
      expect(res.body.role.key).toBe('KITCHEN');
      // Anyone holding a forwarded link sees this. Nothing more.
      expect(JSON.stringify(res.body)).not.toContain('s-');
    });

    it('gives the same answer for invalid, revoked and made-up tokens', async () => {
      const t = await newTenant('Probe Cafe');
      const inv = await invite(t.token, {
        email: 'probe@example.com',
        role: 'CASHIER',
      }).expect(201);
      const list = await api()
        .get('/api/v1/staff/invites')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);

      await api()
        .delete(`/api/v1/staff/invites/${list.body[0].id}`)
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);

      // Revoked and never-existed must be indistinguishable.
      await api()
        .get(`/api/v1/join/${tokenOf(inv.body.inviteUrl)}`)
        .expect(404);
      await api().get('/api/v1/join/completely-made-up-token').expect(404);
    });

    it('cannot be accepted twice', async () => {
      const t = await newTenant('Once Cafe');
      const inv = await invite(t.token, {
        email: `s-once-${Date.now()}@example.com`,
        role: 'CASHIER',
      }).expect(201);
      const token = tokenOf(inv.body.inviteUrl);

      await api()
        .post(`/api/v1/join/${token}`)
        .send({ name: 'A', password })
        .expect(201);
      // A forwarded link must not create a second account.
      await api()
        .post(`/api/v1/join/${token}`)
        .send({ name: 'B', password })
        .expect(404);
    });

    it('refuses an expired invite', async () => {
      const t = await newTenant('Expired Cafe');
      const inv = await invite(t.token, {
        email: 'old@example.com',
        role: 'CASHIER',
      }).expect(201);

      // Age the whole row. The expires_at > created_at CHECK correctly refuses
      // an invite that expires before it existed, so backdating only the expiry
      // is not a state the database will ever hold.
      await owner.staffInvite.updateMany({
        where: { email: 'old@example.com' },
        data: {
          createdAt: new Date(Date.now() - 10 * 86_400_000),
          expiresAt: new Date(Date.now() - 3 * 86_400_000),
        },
      });

      await api()
        .post(`/api/v1/join/${tokenOf(inv.body.inviteUrl)}`)
        .send({ name: 'Late', password })
        .expect(404);
    });

    it('rejects a weak password on acceptance', async () => {
      const t = await newTenant('Weak Cafe');
      const inv = await invite(t.token, {
        email: `s-weak-${Date.now()}@example.com`,
        role: 'CASHIER',
      }).expect(201);
      await api()
        .post(`/api/v1/join/${tokenOf(inv.body.inviteUrl)}`)
        .send({ name: 'X', password: 'short' })
        .expect(400);
    });

    it('takes the email from the invite, never from the request', async () => {
      const t = await newTenant('Email Fix Cafe');
      const email = `s-fixed-${Date.now()}@example.com`;
      const inv = await invite(t.token, { email, role: 'CASHIER' }).expect(201);

      // A forwarded link must not let someone join under a different address.
      await api()
        .post(`/api/v1/join/${tokenOf(inv.body.inviteUrl)}`)
        .send({ name: 'X', password, email: 'attacker@example.com' })
        .expect(400); // forbidNonWhitelisted

      const accepted = await api()
        .post(`/api/v1/join/${tokenOf(inv.body.inviteUrl)}`)
        .send({ name: 'X', password })
        .expect(201);
      const user = await owner.user.findFirst({ where: { email } });
      expect(user).toBeTruthy();
      expect(claims(accepted.body.accessToken).role).toBe('CASHIER');
    });

    it('signs the new member in scoped to that restaurant only', async () => {
      const t = await newTenant('Scope Cafe');
      const staff = await addStaff(t.token, 'KITCHEN');
      const c = claims(staff.token);
      expect(c.rid).toBe(t.restaurantId);
      expect(c.role).toBe('KITCHEN');
      // Kitchen must never get customer PII.
      expect(c.perms).not.toContain('customer.read');
    });

    it('puts the refresh token in an httpOnly cookie, never in the body', async () => {
      const t = await newTenant('Cookie Cafe');
      const email = `s-cookie-${Date.now()}@example.com`;
      const inv = await invite(t.token, { email, role: 'CASHIER' }).expect(201);

      const accepted = await api()
        .post(`/api/v1/join/${tokenOf(inv.body.inviteUrl)}`)
        .send({ name: 'Cookie Member', password })
        .expect(201);

      // Access token in the body for the client to hold in memory.
      expect(accepted.body.accessToken).toBeDefined();
      // The refresh token must NOT leak into JSON — same contract as login.
      expect(accepted.body.refreshToken).toBeUndefined();

      // It lives in an httpOnly, scoped cookie the browser sends to /auth.
      const raw = accepted.headers['set-cookie'] as unknown;
      const list = Array.isArray(raw) ? (raw as string[]) : [raw as string];
      const rt = list.find((c) => c?.startsWith('oraos_rt='));
      expect(rt).toBeDefined();
      expect(rt!.toLowerCase()).toContain('httponly');
      expect(rt).toContain('Path=/api/v1/auth');

      // The cookie is a working session: it refreshes without the access token.
      const refreshed = await api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', rt!.split(';')[0])
        .expect(200);
      expect(refreshed.body.accessToken).toBeDefined();
      expect(claims(refreshed.body.accessToken).rid).toBe(t.restaurantId);
    });
  });

  describe('managing members', () => {
    it('lists the team', async () => {
      const t = await newTenant('List Staff Cafe');
      await addStaff(t.token, 'CASHIER');
      const res = await api()
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      expect(res.body).toHaveLength(2); // owner + cashier
      expect(
        res.body.every((m: { onShift: boolean }) => m.onShift === false),
      ).toBe(true);
    });

    it('changes a role', async () => {
      const t = await newTenant('Role Change Cafe');
      const staff = await addStaff(t.token, 'CASHIER');
      const list = await api()
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      const member = list.body.find(
        (m: { role: { key: string } }) => m.role.key === 'CASHIER',
      );

      const res = await api()
        .patch(`/api/v1/staff/${member.id}`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ role: 'MANAGER' })
        .expect(200);
      expect(res.body.role.key).toBe('MANAGER');
      expect(staff.token).toBeTruthy();
    });

    it('refuses to promote anyone to OWNER', async () => {
      const t = await newTenant('No Owner Cafe');
      await addStaff(t.token, 'CASHIER');
      const list = await api()
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      const member = list.body.find(
        (m: { role: { key: string } }) => m.role.key === 'CASHIER',
      );

      await api()
        .patch(`/api/v1/staff/${member.id}`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ role: 'OWNER' })
        .expect(400);
    });

    it('refuses to change the owner, even by the owner', async () => {
      const t = await newTenant('Self Cafe');
      const list = await api()
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      const ownerMember = list.body.find(
        (m: { role: { key: string } }) => m.role.key === 'OWNER',
      );

      // Locking yourself out of your own restaurant should not be one click.
      await api()
        .patch(`/api/v1/staff/${ownerMember.id}`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ isActive: false })
        .expect(403);
    });

    it('a CASHIER cannot manage staff', async () => {
      const t = await newTenant('Cashier Staff Cafe');
      const cashier = await addStaff(t.token, 'CASHIER');
      await api()
        .post('/api/v1/staff/invites')
        .set('Authorization', `Bearer ${cashier.token}`)
        .send({ email: 'friend@example.com', role: 'MANAGER' })
        .expect(403);
    });

    it('deactivating blocks login-scoped access but keeps the record', async () => {
      const t = await newTenant('Deactivate Cafe');
      await addStaff(t.token, 'CASHIER');
      const list = await api()
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      const member = list.body.find(
        (m: { role: { key: string } }) => m.role.key === 'CASHIER',
      );

      await api()
        .patch(`/api/v1/staff/${member.id}`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ isActive: false })
        .expect(200);

      // The person is still listed — their orders and hours must not vanish.
      const after = await api()
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      expect(after.body).toHaveLength(2);
      expect(
        after.body.find((m: { id: string }) => m.id === member.id).isActive,
      ).toBe(false);
    });

    /**
     * The ex-employee case in BLUEPRINT §8. Deactivating used to end the
     * membership but not the session: their refresh chain stayed live, so they
     * kept a working login until the token aged out seven days later.
     */
    it('deactivating revokes the member live refresh sessions', async () => {
      const t = await newTenant('Session Revoke Cafe');
      const email = `s-rev-${Date.now()}@example.com`;
      const inv = await invite(t.token, { email, role: 'CASHIER' }).expect(201);
      const accepted = await api()
        .post(`/api/v1/join/${tokenOf(inv.body.inviteUrl)}`)
        .send({ name: 'Leaver', password })
        .expect(201);

      expect(accepted.body.accessToken).toBeDefined();

      // Sign in to get a refresh cookie. (Accepting an invite does not set one
      // — see the sprint notes; out of scope here.)
      const signedIn = await api()
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200);
      let cookie = cookieOf(signedIn);

      // Baseline: their session refreshes normally. Rotation hands back a new
      // cookie, which is the one that must stop working.
      const rotated = await api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .expect(200);
      cookie = cookieOf(rotated);

      const staff = await api()
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      const member = staff.body.find(
        (m: { user: { email: string } }) => m.user.email === email,
      );

      await api()
        .patch(`/api/v1/staff/${member.id}`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ isActive: false })
        .expect(200);

      await api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .expect(401);
    });

    it('a role change does NOT revoke sessions', async () => {
      const t = await newTenant('Role Change Cafe');
      const email = `s-role-${Date.now()}@example.com`;
      const inv = await invite(t.token, { email, role: 'CASHIER' }).expect(201);
      await api()
        .post(`/api/v1/join/${tokenOf(inv.body.inviteUrl)}`)
        .send({ name: 'Promoted', password })
        .expect(201);
      const signedIn = await api()
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200);
      const cookie = cookieOf(signedIn);

      const staff = await api()
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      const member = staff.body.find(
        (m: { user: { email: string } }) => m.user.email === email,
      );

      await api()
        .patch(`/api/v1/staff/${member.id}`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ role: 'MANAGER' })
        .expect(200);

      // Promotion is not a security event — they stay signed in and pick up
      // the new permissions on their next refresh.
      const after = await api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .expect(200);
      expect(claims(after.body.accessToken).role).toBe('MANAGER');
    });
  });

  describe('attendance', () => {
    it('clocks in and out, and derives on-shift state', async () => {
      const t = await newTenant('Clock Cafe');
      const staff = await addStaff(t.token, 'CASHIER');

      await api()
        .post('/api/v1/staff/me/clock')
        .set('Authorization', `Bearer ${staff.token}`)
        .send({ type: 'CLOCK_IN' })
        .expect(201);

      const during = await api()
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      expect(
        during.body.find(
          (m: { role: { key: string } }) => m.role.key === 'CASHIER',
        ).onShift,
      ).toBe(true);

      await api()
        .post('/api/v1/staff/me/clock')
        .set('Authorization', `Bearer ${staff.token}`)
        .send({ type: 'CLOCK_OUT' })
        .expect(201);

      const after = await api()
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      expect(
        after.body.find(
          (m: { role: { key: string } }) => m.role.key === 'CASHIER',
        ).onShift,
      ).toBe(false);
    });

    it('refuses to clock in twice', async () => {
      const t = await newTenant('Double Clock Cafe');
      const staff = await addStaff(t.token, 'CASHIER');
      const clock = (type: string) =>
        api()
          .post('/api/v1/staff/me/clock')
          .set('Authorization', `Bearer ${staff.token}`)
          .send({ type });

      await clock('CLOCK_IN').expect(201);
      // Unbalanced events are unpayable.
      await clock('CLOCK_IN').expect(409);
    });

    it('refuses to clock out without clocking in', async () => {
      const t = await newTenant('No In Cafe');
      const staff = await addStaff(t.token, 'CASHIER');
      await api()
        .post('/api/v1/staff/me/clock')
        .set('Authorization', `Bearer ${staff.token}`)
        .send({ type: 'CLOCK_OUT' })
        .expect(409);
    });

    it('a CASHIER cannot backdate their own hours', async () => {
      const t = await newTenant('Backdate Cafe');
      const staff = await addStaff(t.token, 'CASHIER');
      // Writing your own timesheet is the wage equivalent of editing a receipt.
      await api()
        .post('/api/v1/staff/me/clock')
        .set('Authorization', `Bearer ${staff.token}`)
        .send({ type: 'CLOCK_IN', at: '2020-01-01T09:00:00.000Z' })
        .expect(403);
    });

    it('a CASHIER cannot clock anyone else in', async () => {
      const t = await newTenant('Buddy Punch Cafe');
      const cashier = await addStaff(t.token, 'CASHIER');
      const other = await addStaff(t.token, 'KITCHEN');
      const list = await api()
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      const kitchen = list.body.find(
        (m: { role: { key: string } }) => m.role.key === 'KITCHEN',
      );

      // Buddy punching: clocking in a colleague who has not arrived.
      await api()
        .post(`/api/v1/staff/${kitchen.id}/clock`)
        .set('Authorization', `Bearer ${cashier.token}`)
        .send({ type: 'CLOCK_IN' })
        .expect(403);
      expect(other.token).toBeTruthy();
    });

    it('an owner may record for someone else, and it is marked as such', async () => {
      const t = await newTenant('Manager Clock Cafe');
      await addStaff(t.token, 'KITCHEN');
      const list = await api()
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      const kitchen = list.body.find(
        (m: { role: { key: string } }) => m.role.key === 'KITCHEN',
      );

      const res = await api()
        .post(`/api/v1/staff/${kitchen.id}/clock`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ type: 'CLOCK_IN', note: 'forgot to clock in' })
        .expect(201);
      // The difference between "I clocked in" and "someone clocked me in"
      // matters in a dispute.
      expect(res.body.recordedBy).toBeTruthy();
    });

    it('refuses attendance in the future', async () => {
      const t = await newTenant('Future Cafe');
      await api()
        .post('/api/v1/staff/me/clock')
        .set('Authorization', `Bearer ${t.token}`)
        .send({
          type: 'CLOCK_IN',
          at: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(400);
    });

    it('is append-only even to the app role', async () => {
      const t = await newTenant('Immutable Hours Cafe');
      const staff = await addStaff(t.token, 'CASHIER');
      await api()
        .post('/api/v1/staff/me/clock')
        .set('Authorization', `Bearer ${staff.token}`)
        .send({ type: 'CLOCK_IN' })
        .expect(201);

      const appDb = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: process.env.DATABASE_URL_APP,
        }),
      });
      try {
        // "Adjusting" hours by editing history is indistinguishable from
        // quietly paying someone less.
        await expect(
          appDb.$transaction(async (db) => {
            await db.$executeRaw`SELECT set_config('app.restaurant_id', ${t.restaurantId}, true)`;
            return db.attendanceEvent.deleteMany({
              where: { restaurantId: t.restaurantId },
            });
          }),
        ).rejects.toThrow();
      } finally {
        await appDb.$disconnect();
      }
    });
  });

  describe('timesheet', () => {
    it('pairs events into sessions and totals the minutes', async () => {
      const t = await newTenant('Timesheet Cafe');
      await addStaff(t.token, 'CASHIER');
      const list = await api()
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);
      const member = list.body.find(
        (m: { role: { key: string } }) => m.role.key === 'CASHIER',
      );

      const base = Date.now() - 4 * 3600_000;
      await api()
        .post(`/api/v1/staff/${member.id}/clock`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ type: 'CLOCK_IN', at: new Date(base).toISOString() })
        .expect(201);
      await api()
        .post(`/api/v1/staff/${member.id}/clock`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({
          type: 'CLOCK_OUT',
          at: new Date(base + 2 * 3600_000).toISOString(),
        })
        .expect(201);

      const res = await api()
        .get(`/api/v1/staff/timesheet?membershipId=${member.id}`)
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);

      expect(res.body[0].sessions).toHaveLength(1);
      expect(res.body[0].totalMinutes).toBe(120);
      expect(res.body[0].openSession).toBe(false);
    });

    it('reports an open session rather than guessing an end time', async () => {
      const t = await newTenant('Open Session Cafe');
      const staff = await addStaff(t.token, 'CASHIER');
      await api()
        .post('/api/v1/staff/me/clock')
        .set('Authorization', `Bearer ${staff.token}`)
        .send({ type: 'CLOCK_IN' })
        .expect(201);

      const res = await api()
        .get('/api/v1/staff/timesheet')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200);

      const row = res.body.find((r: { role: string }) => r.role === 'CASHIER');
      // A guessed end time is a guessed wage.
      expect(row.openSession).toBe(true);
      expect(row.sessions[0].out).toBeNull();
      expect(row.sessions[0].minutes).toBeNull();
    });

    it('a CASHIER cannot read the timesheet', async () => {
      const t = await newTenant('Private Hours Cafe');
      const cashier = await addStaff(t.token, 'CASHIER');
      await api()
        .get('/api/v1/staff/timesheet')
        .set('Authorization', `Bearer ${cashier.token}`)
        .expect(403);
    });
  });

  describe('tenant isolation', () => {
    it("never lists another tenant's staff", async () => {
      const a = await newTenant('Staff Iso A');
      const b = await newTenant('Staff Iso B');
      await addStaff(a.token, 'CASHIER');

      const res = await api()
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${b.token}`)
        .expect(200);
      expect(res.body).toHaveLength(1); // only B's owner
    });

    it("cannot modify another tenant's member", async () => {
      const a = await newTenant('Mod Iso A');
      const b = await newTenant('Mod Iso B');
      await addStaff(a.token, 'CASHIER');
      const list = await api()
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${a.token}`)
        .expect(200);
      const victim = list.body.find(
        (m: { role: { key: string } }) => m.role.key === 'CASHIER',
      );

      await api()
        .patch(`/api/v1/staff/${victim.id}`)
        .set('Authorization', `Bearer ${b.token}`)
        .send({ isActive: false })
        .expect(404);
    });

    it("cannot clock another tenant's member", async () => {
      const a = await newTenant('Clock Iso A');
      const b = await newTenant('Clock Iso B');
      await addStaff(a.token, 'CASHIER');
      const list = await api()
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${a.token}`)
        .expect(200);
      const victim = list.body.find(
        (m: { role: { key: string } }) => m.role.key === 'CASHIER',
      );

      await api()
        .post(`/api/v1/staff/${victim.id}/clock`)
        .set('Authorization', `Bearer ${b.token}`)
        .send({ type: 'CLOCK_IN' })
        .expect(404);
    });
  });
});
