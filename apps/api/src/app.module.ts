import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { TenantContextInterceptor } from './common/interceptors/tenant-context.interceptor';
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

          genReqId: (_req, res) => {
            const id = randomUUID();
            res.setHeader('X-Request-Id', id);
            return id;
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
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },

    // Order matters. Throttle before touching the database, authenticate
    // before authorising.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },

    // Runs after the guards, so the token is already verified when its claims
    // are placed into AsyncLocalStorage.
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
})
export class AppModule {}
