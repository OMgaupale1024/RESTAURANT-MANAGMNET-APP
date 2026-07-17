import { Controller, Get } from '@nestjs/common';
import { Public } from './common/decorators/auth.decorators';

@Controller('health')
export class HealthController {
  // Liveness only — proves the process is up and serving.
  // Dependency checks (database, redis) are added when those exist.
  @Public()
  @Get()
  check() {
    return { status: 'ok', uptime: Math.floor(process.uptime()) };
  }
}
