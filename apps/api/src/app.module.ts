import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { stdSerializers } from 'pino';
import { randomUUID } from 'node:crypto';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { SlowRequestInterceptor } from './common/interceptors/slow-request.interceptor';
import { TenantContextInterceptor } from './common/interceptors/tenant-context.interceptor';
import { ShutdownService } from './common/lifecycle/shutdown.service';
import { redactUrl } from './common/logging/redact-url';
import { validateEnv } from './config/env';
import { HealthController } from './health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { RestaurantsModule } from './modules/restaurants/restaurants.module';
import { CatalogueModule } from './modules/catalogue/catalogue.module';
import { OrdersModule } from './modules/orders/orders.module';
import { CustomersModule } from './modules/customers/customers.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { StaffModule } from './modules/staff/staff.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AiModule } from './modules/ai/ai.module';
import { MarketingModule } from './modules/marketing/marketing.module';
import { ReportsModule } from './modules/reports/reports.module';
import { CashModule } from './modules/cash/cash.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),

    // Baseline limit for every route. Auth routes tighten it further.
    // Keyed on client IP, so it is always active — including in tests, which
    // vary the IP rather than switching the limiter off. There is deliberately
    // no flag to disable this: a rate limiter with an off switch eventually
    // gets switched off in production.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),

    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('LOG_LEVEL'),

          // Propagate a caller-supplied X-Request-Id so a trace survives across
          // services, but only if it is a safe, bounded token — a crafted header
          // must not forge or pollute the log stream. Otherwise generate one.
          // Either way it goes back on the response for the client to quote.
          genReqId: (req, res) => {
            const inbound = req.headers['x-request-id'];
            const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
            const id =
              candidate && /^[A-Za-z0-9._-]{1,64}$/.test(candidate)
                ? candidate
                : randomUUID();
            res.setHeader('X-Request-Id', id);
            return id;
          },

          // Mask the staff-invite token that rides in the URL path
          // (/api/v1/join/<token>) before it reaches the access log. Headers and
          // bodies are handled by redact below.
          serializers: {
            req(req: { url?: string }) {
              const s = stdSerializers.req(req as never);
              return { ...s, url: redactUrl(s.url) };
            },
          },

          // Redaction lives here, not at call sites — one place to be right.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              'req.body.password',
              'req.body.token',
              'req.body.refreshToken',
              // Route params carry the staff-invite token as a path segment
              // (/join/:token). The url string is masked by the serializer
              // above; this closes the same token in the parsed params.
              'req.params',
            ],
            censor: '[REDACTED]',
          },

          transport:
            config.get<string>('NODE_ENV') === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),

    PrismaModule,
    AuthModule,
    RestaurantsModule,
    CatalogueModule,
    OrdersModule,
    CustomersModule,
    InventoryModule,
    StaffModule,
    RealtimeModule,
    AnalyticsModule,
    AiModule,
    MarketingModule,
    ReportsModule,
    CashModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },

    // Order matters. Throttle before touching the database, authenticate
    // before authorising.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },

    // Outermost interceptor, so it times the whole handler chain.
    { provide: APP_INTERCEPTOR, useClass: SlowRequestInterceptor },

    // Runs after the guards, so the token is already verified when its claims
    // are placed into AsyncLocalStorage.
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },

    // Logs when a SIGTERM/SIGINT-triggered shutdown runs (mechanics are Nest's
    // enableShutdownHooks in main.ts).
    ShutdownService,
  ],
})
export class AppModule {}
