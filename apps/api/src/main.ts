import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Register the body parsers ourselves (below) so the menu scanner can post
    // base64 images. Nest's default json parser caps at ~100kb.
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);

  app.use(helmet());
  app.use(cookieParser());

  // Menu scans post a few downscaled base64 images as JSON, so the default
  // ~100kb cap is far too small. Every scan route is authenticated, throttled,
  // and gated behind product.manage, so a raised cap is bounded in practice.
  // ponytail: one global 12mb cap; a per-route limit would need a second parser
  // wired to the extract path — revisit only if a large-body abuse shows up.
  app.useBodyParser('json', { limit: '12mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '12mb' });

  // Behind a platform proxy (Render/Fly/Vercel), req.ip is the proxy's address
  // unless X-Forwarded-For is trusted. Rate limiting keyed on the wrong IP would
  // throttle every user as one.
  app.set('trust proxy', 1);

  // Explicit allowlist. Never reflect the request origin.
  app.enableCors({
    origin: config.get<string[]>('CORS_ORIGINS'),
    credentials: true, // refresh token travels as an httpOnly cookie
  });

  app.setGlobalPrefix('api/v1');

  // On a redeploy the platform sends SIGTERM. Without this, the process is
  // killed mid-request and the Postgres pool is never drained. Shutdown hooks
  // let Nest run onModuleDestroy (PrismaService.$disconnect) and finish
  // in-flight work before exiting.
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown properties
      forbidNonWhitelisted: true, // ...and reject the request that sent them
      transform: true, // apply DTO types
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  await app.listen(config.get<number>('PORT')!);
}

void bootstrap();
