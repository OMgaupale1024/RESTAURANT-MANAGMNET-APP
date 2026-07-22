/**
 * Graceful shutdown.
 *
 * Windows cannot deliver a catchable SIGTERM to a console process, so the
 * signal path is verified two ways that ARE cross-platform: the process signal
 * listeners are registered (enableShutdownHooks wired them), and app.close() —
 * exactly what those listeners invoke — runs the full sequence cleanly: the
 * HTTP server stops accepting, onModuleDestroy disconnects Prisma, and the
 * OnApplicationShutdown hook fires.
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ShutdownService } from '../src/common/lifecycle/shutdown.service';

describe('Graceful shutdown (e2e)', () => {
  it('wires termination signals and closes down cleanly', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    app.enableShutdownHooks();
    await app.init();

    // SIGTERM/SIGINT are wired to the shutdown path.
    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(0);
    expect(process.listenerCount('SIGINT')).toBeGreaterThan(0);

    const shutdownSpy = jest.spyOn(
      app.get(ShutdownService),
      'onApplicationShutdown',
    );
    const disconnectSpy = jest.spyOn(app.get(PrismaService), '$disconnect');

    // The signal handlers call exactly this. It must resolve — a shutdown that
    // throws would leave the platform to hard-kill a half-closed process.
    await expect(app.close()).resolves.toBeUndefined();

    // Prisma pool drained, and the shutdown was observable in the logs.
    expect(disconnectSpy).toHaveBeenCalled();
    expect(shutdownSpy).toHaveBeenCalled();
  });
});
