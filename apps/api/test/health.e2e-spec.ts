/**
 * Monitoring surface, end-to-end: liveness/readiness payloads, request-id
 * generation + propagation, and that health probes are never rate-limited.
 */
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

let app: NestExpressApplication;

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
});

const server = () => app.getHttpServer();

describe('Health (e2e)', () => {
  it('liveness reports status, uptime, version and timestamp', async () => {
    const res = await request(server()).get('/api/v1/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version.length).toBeGreaterThan(0);
    expect(new Date(res.body.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('readiness proves the database is reachable', async () => {
    const res = await request(server()).get('/api/v1/health/ready').expect(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.database).toBe('up');
  });

  it('returns a generated X-Request-Id on every response', async () => {
    const res = await request(server()).get('/api/v1/health').expect(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('propagates a safe caller-supplied X-Request-Id', async () => {
    const res = await request(server())
      .get('/api/v1/health')
      .set('X-Request-Id', 'trace-abc_123')
      .expect(200);
    expect(res.headers['x-request-id']).toBe('trace-abc_123');
  });

  it('rejects a malformed X-Request-Id and generates its own', async () => {
    const res = await request(server())
      .get('/api/v1/health')
      .set('X-Request-Id', 'not a valid id !!')
      .expect(200);
    expect(res.headers['x-request-id']).not.toBe('not a valid id !!');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('does not rate-limit health probes (over the global limit of 100/min)', async () => {
    // The baseline throttle is 100/min per IP. Health is @SkipThrottle, so 120
    // hits in one window must all succeed — otherwise a probe would start
    // getting 429s and the platform would read the app as down.
    //
    // Sequential, not concurrent: firing 10 at a time opened a socket burst
    // against the in-process server that resets under load on Linux CI runners
    // (the rest of the suite is sequential and stable there). One at a time is
    // deterministic across platforms and still proves the point — a throttled
    // route 429s after 100 regardless of concurrency, so this fails fast on a
    // real regression.
    for (let i = 0; i < 120; i++) {
      await request(server()).get('/api/v1/health').expect(200);
    }
  });
});
