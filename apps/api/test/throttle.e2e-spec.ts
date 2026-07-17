/**
 * Rate limiting, verified for real (no guard override).
 *
 * Separate file because auth.e2e-spec.ts disables the throttler to test auth
 * logic. Without this suite, disabling it there would leave the credential
 * stuffing defence completely untested.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Rate limiting (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('blocks brute-force login attempts after 5 tries in a minute', async () => {
    const attempt = () =>
      request(app.getHttpServer()).post('/api/v1/auth/login').send({
        email: 'attacker@example.com',
        password: 'guessing-a-password',
      });

    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await attempt();
      codes.push(res.status);
    }

    // The first few are honest failures; the rest must be refused outright.
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes[codes.length - 1]).toBe(429);
  });
});
