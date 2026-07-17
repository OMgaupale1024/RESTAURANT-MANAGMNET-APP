import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../prisma/prisma.service';
import type { SecurityEventType } from '../../generated/prisma/client';

export type SecurityEventInput = {
  type: SecurityEventType;
  userId?: string | null;
  email?: string | null;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
};

@Injectable()
export class SecurityEventService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Records an identity-level security event.
   *
   * Never throws. An audit write failing must not take down login — the
   * alternative is a logging bug becoming an outage. A failure is logged
   * loudly instead, because silently losing the security trail is its own
   * problem.
   *
   * Deliberately fire-and-forget from the caller's perspective: no auth path
   * should wait on this.
   */
  record(input: SecurityEventInput): void {
    this.prisma.securityEvent
      .create({
        data: {
          type: input.type,
          userId: input.userId ?? null,
          // Recorded even for unknown accounts: a burst of LOGIN_FAILED against
          // addresses that do not exist is exactly what credential stuffing
          // looks like.
          email: input.email ?? null,
          ipAddress: input.ip,
          userAgent: input.userAgent?.slice(0, 255),
          metadata: input.metadata as never,
        },
      })
      .catch((err: unknown) => {
        this.logger.error(
          { err, type: input.type },
          'Failed to record security event',
        );
      });
  }
}
