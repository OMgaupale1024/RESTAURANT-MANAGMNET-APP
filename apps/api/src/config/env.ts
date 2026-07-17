import { z } from 'zod';

const pgUrl = z
  .string()
  .min(1)
  .refine((v) => v.startsWith('postgresql://') || v.startsWith('postgres://'), {
    message: 'must be a postgresql:// connection string',
  });

// Validated once at boot. A missing or malformed variable crashes startup
// rather than surfacing as a runtime failure during a real request.
const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3001),

    // No default: a wrong-but-present database URL is worse than a missing one,
    // because it silently connects somewhere unintended.
    //
    // Owner role. Migrations only (DDL). On Neon this role has BYPASSRLS, so it
    // ignores every tenant policy — it must never serve application traffic.
    DATABASE_URL: pgUrl,

    // Least-privilege runtime role (oraos_api). Everything the app does at
    // runtime goes through this. Created by `pnpm db:setup-app-role`.
    DATABASE_URL_APP: pgUrl,

    // Comma-separated list of allowed browser origins.
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),

    // No default, ever. A default JWT secret that reaches production means
    // anyone who has read the source can mint valid tokens for any account.
    JWT_SECRET: z
      .string()
      .min(32, { message: 'must be at least 32 characters of high entropy' }),

    // Short-lived by design: the access token cannot be revoked, so its lifetime
    // is the blast radius of a stolen one.
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),

    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
  })
  .superRefine((env, ctx) => {
    // The one misconfiguration that silently destroys tenant isolation:
    // pointing runtime traffic at the owner role. It would work perfectly and
    // leak every tenant's data to every other tenant. Refuse to boot.
    if (env.DATABASE_URL_APP === env.DATABASE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL_APP'],
        message:
          'must not equal DATABASE_URL. The owner role has BYPASSRLS and would ' +
          'disable tenant isolation. Run: pnpm db:setup-app-role',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Thrown before the app is listening, so this is a startup crash.
    throw new Error(`Invalid environment variables:\n${issues}`);
  }

  return result.data;
}
