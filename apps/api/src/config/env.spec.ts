import { validateEnv } from './env';

/**
 * The production boot guards (Step 20). These are a security boundary — a
 * misconfigured production deploy must fail to boot, not boot insecure — so
 * they get verified directly rather than trusted.
 */
const OWNER = 'postgresql://owner:pw@host/db?sslmode=verify-full';
const APP = 'postgresql://oraos_api:pw@host/db?sslmode=verify-full';

const prod = (over: Record<string, unknown> = {}) => ({
  NODE_ENV: 'production',
  DATABASE_URL: OWNER,
  DATABASE_URL_APP: APP,
  JWT_SECRET: 'x'.repeat(32),
  CORS_ORIGINS: 'https://app.example.com',
  WEB_URL: 'https://app.example.com',
  ...over,
});

describe('validateEnv', () => {
  it('accepts a valid production config', () => {
    expect(() => validateEnv(prod())).not.toThrow();
  });

  it('accepts local dev over http with sslmode=require', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://owner:pw@host/db?sslmode=require',
        DATABASE_URL_APP: 'postgresql://oraos_api:pw@host/db?sslmode=require',
        JWT_SECRET: 'x'.repeat(32),
        // CORS_ORIGINS and WEB_URL default to localhost.
      }),
    ).not.toThrow();
  });

  it('refuses to boot if the runtime role equals the owner role', () => {
    expect(() => validateEnv(prod({ DATABASE_URL_APP: OWNER }))).toThrow(
      /must not equal DATABASE_URL/,
    );
  });

  it('requires sslmode=verify-full on both URLs in production', () => {
    expect(() =>
      validateEnv(
        prod({ DATABASE_URL: OWNER.replace('verify-full', 'require') }),
      ),
    ).toThrow(/verify-full/);
    expect(() =>
      validateEnv(
        prod({ DATABASE_URL_APP: APP.replace('verify-full', 'require') }),
      ),
    ).toThrow(/verify-full/);
  });

  it('rejects a non-https CORS origin in production', () => {
    expect(() =>
      validateEnv(prod({ CORS_ORIGINS: 'http://app.example.com' })),
    ).toThrow(/https/);
  });

  it('rejects a non-https WEB_URL in production', () => {
    expect(() =>
      validateEnv(prod({ WEB_URL: 'http://app.example.com' })),
    ).toThrow(/https/);
  });

  it('rejects a short JWT secret', () => {
    expect(() => validateEnv(prod({ JWT_SECRET: 'tooshort' }))).toThrow();
  });

  describe('email config', () => {
    it('accepts no email config at all (dev transport)', () => {
      expect(() => validateEnv(prod())).not.toThrow();
    });

    it('requires MAIL_FROM when a Resend key is set', () => {
      expect(() => validateEnv(prod({ RESEND_API_KEY: 're_123' }))).toThrow(
        /MAIL_FROM/,
      );
    });

    it('rejects a MAIL_FROM without a real address', () => {
      expect(() =>
        validateEnv(
          prod({ RESEND_API_KEY: 're_123', MAIL_FROM: 'just a name' }),
        ),
      ).toThrow(/MAIL_FROM/);
    });

    it('accepts a valid key + from-address', () => {
      expect(() =>
        validateEnv(
          prod({
            RESEND_API_KEY: 're_123',
            MAIL_FROM: 'OraOS <noreply@oraos.app>',
          }),
        ),
      ).not.toThrow();
    });
  });
});
