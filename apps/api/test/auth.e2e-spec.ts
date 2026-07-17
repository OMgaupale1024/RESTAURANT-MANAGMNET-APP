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
});
