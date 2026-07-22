import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from './common/decorators/auth.decorators';
import { PrismaService } from './prisma/prisma.service';

// Resolved once at load. APP_VERSION (a release tag or git SHA set by the
// deploy) wins; otherwise fall back to the package version. Never throws — an
// unreadable package.json must not break the liveness probe.
const VERSION: string =
  process.env.APP_VERSION ??
  (() => {
    try {
      const pkg = JSON.parse(
        readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
      ) as { version?: string };
      return pkg.version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  })();

// Probes are hit continuously by the platform; a rate-limit 429 would read as
// "app down" and trigger a restart. Health must never be throttled.
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  // Liveness — proves the process is up and serving. Deliberately does NOT
  // touch the database: a liveness probe that fails on a transient DB blip
  // would have the platform kill an otherwise-healthy process.
  @Public()
  @Get()
  check() {
    return {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      version: VERSION,
      timestamp: new Date().toISOString(),
    };
  }

  // Readiness — proves the process can actually serve traffic, which means the
  // database is reachable. The platform routes traffic only while this passes,
  // so an API whose DB is down is taken out of rotation instead of erroring
  // every request. No tenant table is touched, so this needs no RLS context.
  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        database: 'down',
        timestamp: new Date().toISOString(),
      });
    }
    return {
      status: 'ready',
      database: 'up',
      timestamp: new Date().toISOString(),
    };
  }
}
