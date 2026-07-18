import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from './common/decorators/auth.decorators';
import { PrismaService } from './prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  // Liveness — proves the process is up and serving. Deliberately does NOT
  // touch the database: a liveness probe that fails on a transient DB blip
  // would have the platform kill an otherwise-healthy process.
  @Public()
  @Get()
  check() {
    return { status: 'ok', uptime: Math.floor(process.uptime()) };
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
      });
    }
    return { status: 'ready' };
  }
}
