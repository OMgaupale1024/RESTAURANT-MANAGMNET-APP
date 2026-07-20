/**
 * Auth end-to-end, against the real database.
 *
 * These are written as attacks, not confirmations. Each is something a real
 * attacker or a real bug would attempt.
 */
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const COOKIE = 'oraos_rt';
const password = 'correct-horse-battery';

let app: NestExpressApplication;
let prisma: PrismaService;
let email: string;

/**
 * Rate limiting stays ON for these tests — it is a real security control, and
 * switching it off to make tests pass would leave it unverified.
 *
 * Instead each request arrives from a unique IP, exactly as separate real
 * users would. The limiter keys on IP, so it never trips while the full guard
 * chain still runs. throttle.e2e-spec.ts proves it does trip when it should.
 */
let ipCounter = 0;
function freshIp(): string {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

/** supertest bound to a fresh client IP. */
function api() {
  const ip = freshIp();
  const server = app.getHttpServer();
  return {
    post: (url: string) => request(server).post(url).set('X-Forwarded-For', ip),
    get: (url: string) => request(server).get(url).set('X-Forwarded-For', ip),
  };
}

function refreshCookie(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.split(';')[0]
    .split('=')[1];
}

const register = () =>
  api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Test User' });

describe('Auth (e2e)', () => {
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.use(cookieParser());
    // Mirrors main.ts, so X-Forwarded-For is honoured.
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

  beforeEach(() => {
    email = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: 't-' } } });
    await app.close();
  });

  describe('register', () => {
    it('creates an account and returns an access token', async () => {
      const res = await register().expect(201);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.tokenType).toBe('Bearer');
      // The refresh token must never appear in the response body.
      expect(res.body.refreshToken).toBeUndefined();
    });

    it('sets the refresh token as an httpOnly, SameSite=Strict cookie', async () => {
      const res = await register().expect(201);
      const raw = res.headers['set-cookie'];
      const list = Array.isArray(raw) ? raw : [raw];
      const cookie = list.find((c: string) => c.startsWith(COOKIE))!;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
    });

    it('never stores the password in plaintext', async () => {
      await register().expect(201);
      const user = await prisma.user.findUnique({ where: { email } });
      expect(user!.passwordHash).not.toBe(password);
      expect(user!.passwordHash).toMatch(/^\$2[aby]\$12\$/); // bcrypt, cost 12
    });

    it('rejects a weak password', () =>
      api()
        .post('/api/v1/auth/register')
        .send({ email, password: 'short', name: 'x' })
        .expect(400));

    it('rejects a duplicate email', async () => {
      await register().expect(201);
      await register().expect(409);
    });

    it('rejects unknown properties rather than trusting them (mass assignment)', () =>
      api()
        .post('/api/v1/auth/register')
        .send({ email, password, name: 'x', isActive: true, id: 'forged' })
        .expect(400));
  });

  describe('login', () => {
    it('succeeds with correct credentials', async () => {
      await register().expect(201);
      const res = await api()
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200);
      expect(res.body.accessToken).toBeDefined();
    });

    it('rejects a wrong password', async () => {
      await register().expect(201);
      await api()
        .post('/api/v1/auth/login')
        .send({ email, password: 'wrong-password-here' })
        .expect(401);
    });

    it('gives an identical error for unknown email and wrong password', async () => {
      await register().expect(201);
      const unknown = await api()
        .post('/api/v1/auth/login')
        .send({ email: 'nobody-here@example.com', password })
        .expect(401);
      const wrong = await api()
        .post('/api/v1/auth/login')
        .send({ email, password: 'wrong-password-here' })
        .expect(401);
      // Different messages would let an attacker enumerate valid accounts.
      expect(unknown.body.message).toBe(wrong.body.message);
    });

    it('refuses a deactivated account', async () => {
      await register().expect(201);
      await prisma.user.update({ where: { email }, data: { isActive: false } });
      await api()
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(401);
    });
  });

  describe('protected routes', () => {
    it('rejects a request with no token', () =>
      api().get('/api/v1/auth/me').expect(401));

    it('rejects a malformed token', () =>
      api()
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer not.a.real.token')
        .expect(401));

    it('rejects a token signed with a different secret', async () => {
      const jwt = require('jsonwebtoken');
      const forged = jwt.sign(
        { sub: 'x', typ: 'access' },
        'attacker-secret-attacker-secret-32',
        { issuer: 'oraos', audience: 'oraos-api' },
      );
      await api()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
    });

    it('accepts a valid token and never leaks the password hash', async () => {
      const res = await register().expect(201);
      const me = await api()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
      expect(me.body.user.email).toBe(email);
      expect(me.body.user.passwordHash).toBeUndefined();
      // A fresh account has no restaurant yet — that is Step 8.
      expect(me.body.memberships).toEqual([]);
    });
  });

  describe('refresh rotation', () => {
    it('issues a new pair and invalidates the previous token', async () => {
      const reg = await register().expect(201);
      const first = refreshCookie(reg)!;

      const res = await api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${COOKIE}=${first}`)
        .expect(200);

      expect(refreshCookie(res)).not.toBe(first);
      expect(res.body.accessToken).toBeDefined();
    });

    it('detects reuse of a rotated token and kills the whole family', async () => {
      const reg = await register().expect(201);
      const first = refreshCookie(reg)!;

      // Legitimate rotation.
      const rotated = await api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${COOKIE}=${first}`)
        .expect(200);
      const second = refreshCookie(rotated)!;

      // Attacker replays the stolen original.
      await api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${COOKIE}=${first}`)
        .expect(401);

      // The victim's current token must now be dead too: we cannot tell which
      // party was stolen from, so the entire chain is revoked.
      await api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${COOKIE}=${second}`)
        .expect(401);
    });

    it('rejects an invented refresh token', () =>
      api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${COOKIE}=totally-invented`)
        .expect(401));

    it('stores only a hash of the refresh token', async () => {
      const reg = await register().expect(201);
      const plain = refreshCookie(reg)!;
      // Finding a row keyed by the plaintext would mean it was stored raw.
      const row = await prisma.refreshToken.findFirst({
        where: { tokenHash: plain },
      });
      expect(row).toBeNull();
    });
  });

  describe('logout', () => {
    it('revokes the refresh token', async () => {
      const reg = await register().expect(201);
      const rt = refreshCookie(reg)!;

      await api()
        .post('/api/v1/auth/logout')
        .set('Cookie', `${COOKIE}=${rt}`)
        .expect(204);

      await api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${COOKIE}=${rt}`)
        .expect(401);
    });
  });

  /**
   * The Settings card says "Sign out everywhere". It used to call plain
   * /logout, which revokes only the token in THIS browser's cookie — so a lost
   * phone or a shared tablet stayed signed in for the full 7 days while the
   * user was told otherwise.
   */
  describe('logout-all', () => {
    /** Two independent sessions for one user: device A and device B. */
    async function twoDevices() {
      const a = await register().expect(201);
      const b = await api()
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200);
      const rtA = refreshCookie(a)!;
      const rtB = refreshCookie(b)!;
      expect(rtA).not.toBe(rtB);
      return { accessA: a.body.accessToken as string, rtA, rtB };
    }

    it('revokes sessions on every device, not just this one', async () => {
      const { accessA, rtA, rtB } = await twoDevices();

      await api()
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${accessA}`)
        .expect(204);

      // Including the caller's own — "everywhere" means everywhere.
      await api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${COOKIE}=${rtA}`)
        .expect(401);
      await api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${COOKIE}=${rtB}`)
        .expect(401);
    });

    it('plain logout still leaves the other device signed in', async () => {
      const { rtA, rtB } = await twoDevices();

      await api()
        .post('/api/v1/auth/logout')
        .set('Cookie', `${COOKIE}=${rtA}`)
        .expect(204);

      await api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${COOKIE}=${rtA}`)
        .expect(401);
      // Untouched. This is exactly why logout-all had to be its own route
      // rather than a change to logout: signing out of the till must not sign
      // the kitchen tablet out too.
      await api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${COOKIE}=${rtB}`)
        .expect(200);
    });

    it('requires authentication, unlike logout', async () => {
      await api().post('/api/v1/auth/logout-all').expect(401);
    });

    /**
     * The race that made logout-all bypassable (reproduced 6/6 before the
     * session epoch): a refresh already in flight inserts its replacement
     * AFTER the revocation sweep, so the sweep never sees it.
     */
    it('a refresh racing logout-all cannot leave a usable session', async () => {
      const reg = await register().expect(201);
      const rt = refreshCookie(reg)!;
      const access = reg.body.accessToken as string;

      // Fire both at the same instant, repeatedly — one round is not evidence.
      const [refreshed] = await Promise.all([
        api()
          .post('/api/v1/auth/refresh')
          .set('Cookie', `${COOKIE}=${rt}`)
          .then((r) => r),
        api()
          .post('/api/v1/auth/logout-all')
          .set('Authorization', `Bearer ${access}`)
          .then((r) => r),
      ]);

      // Whether the refresh won or lost the race, nothing usable may survive.
      const survivor = refreshCookie(refreshed);
      if (survivor) {
        await api()
          .post('/api/v1/auth/refresh')
          .set('Cookie', `${COOKIE}=${survivor}`)
          .expect(401);
      }
      // And no unrevoked token may be left behind for this user.
      const live = await prisma.refreshToken.count({
        where: { user: { email }, revokedAt: null },
      });
      expect(live).toBe(0);
    });

    it('refuses a token whose family predates the epoch, even if minted after', async () => {
      const reg = await register().expect(201);
      const rt = refreshCookie(reg)!;
      const access = reg.body.accessToken as string;

      // Rotate once so the family has a second, younger token.
      const rotated = await api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${COOKIE}=${rt}`)
        .expect(200);
      const younger = refreshCookie(rotated)!;

      await api()
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${access}`)
        .expect(204);

      // The token itself is young, but its family began before the epoch.
      await api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${COOKIE}=${younger}`)
        .expect(401);
    });

    it('is idempotent when called repeatedly', async () => {
      const reg = await register().expect(201);
      const access = reg.body.accessToken as string;
      for (let i = 0; i < 3; i++) {
        await api()
          .post('/api/v1/auth/logout-all')
          .set('Authorization', `Bearer ${access}`)
          .expect(204);
      }
      const live = await prisma.refreshToken.count({
        where: { user: { email }, revokedAt: null },
      });
      expect(live).toBe(0);
    });

    it('lets a fresh login work normally after the epoch is set', async () => {
      const reg = await register().expect(201);
      await api()
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${reg.body.accessToken}`)
        .expect(204);

      // A new login starts a new family, after the epoch.
      const again = await api()
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200);
      await api()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${COOKIE}=${refreshCookie(again)!}`)
        .expect(200);
    });

    /**
     * select-restaurant mints a refresh session but is guarded by the ACCESS
     * token, which outlives logout-all by up to 15 minutes. Before the epoch
     * check it could therefore start a brand-new family and undo the
     * revocation — verified reachable.
     */
    it('a surviving access token cannot re-establish a session via select-restaurant', async () => {
      const reg = await register().expect(201);
      const access = reg.body.accessToken as string;
      const cookie = refreshCookie(reg)!;

      const created = await api()
        .post('/api/v1/restaurants')
        .set('Authorization', `Bearer ${access}`)
        .send({ name: 'Epoch Cafe' })
        .expect(201);
      const restaurantId = created.body.restaurant.id as string;

      await api()
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${access}`)
        .expect(204);

      // The access token is still cryptographically valid here.
      await api()
        .post('/api/v1/auth/select-restaurant')
        .set('Authorization', `Bearer ${access}`)
        .set('Cookie', `${COOKIE}=${cookie}`)
        .send({ restaurantId })
        .expect(401);

      // ...and dropping the cookie must not help either.
      await api()
        .post('/api/v1/auth/select-restaurant')
        .set('Authorization', `Bearer ${access}`)
        .send({ restaurantId })
        .expect(401);
    });

    it('still allows select-restaurant on a session newer than the epoch', async () => {
      const reg = await register().expect(201);
      const created = await api()
        .post('/api/v1/restaurants')
        .set('Authorization', `Bearer ${reg.body.accessToken}`)
        .send({ name: 'Fresh Cafe' })
        .expect(201);

      await api()
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${reg.body.accessToken}`)
        .expect(204);

      // `iat` is whole seconds, so the check fails closed inside the second the
      // epoch lands in. Wait past it — a human typing a password takes longer.
      await new Promise((r) => setTimeout(r, 1100));

      // A fresh login is minted after the epoch and must work normally.
      const again = await api()
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200);
      await api()
        .post('/api/v1/auth/select-restaurant')
        .set('Authorization', `Bearer ${again.body.accessToken}`)
        .set('Cookie', `${COOKIE}=${refreshCookie(again)!}`)
        .send({ restaurantId: created.body.restaurant.id })
        .expect(200);
    });

    it('clears the refresh cookie on this device too', async () => {
      const reg = await register().expect(201);
      const res = await api()
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${reg.body.accessToken}`)
        .expect(204);

      const raw = res.headers['set-cookie'];
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      expect(
        list.some(
          (c) =>
            c.startsWith(`${COOKIE}=;`) || /Expires=Thu, 01 Jan 1970/.test(c),
        ),
      ).toBe(true);
    });
  });
});
