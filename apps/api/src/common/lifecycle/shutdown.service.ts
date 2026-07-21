import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

/**
 * Makes shutdown observable.
 *
 * The mechanics are handled by Nest: main.ts calls enableShutdownHooks(), so a
 * SIGTERM/SIGINT stops the HTTP server accepting new connections, runs every
 * onModuleDestroy (PrismaService.$disconnect drains the pool), and lets the
 * process exit once in-flight work finishes. This just records that it happened
 * — a deploy that hangs on shutdown is otherwise invisible in the logs.
 */
@Injectable()
export class ShutdownService implements OnApplicationShutdown {
  constructor(private readonly logger: PinoLogger) {}

  onApplicationShutdown(signal?: string) {
    this.logger.info({ signal: signal ?? 'unknown' }, 'Shutting down');
  }
}
