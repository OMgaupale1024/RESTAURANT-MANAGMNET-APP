import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SecurityEventService } from './security-event.service';

export type AccessTokenPayload = {
  sub: string; // userId
  email: string;
  rid: string | null; // restaurantId
  mid: string | null; // membershipId
  role: string | null;
  perms: string[];
  typ: 'access';
};

export type IssuedTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

/** Opaque tokens are stored only as a hash — a DB leak must not yield logins. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly events: SecurityEventService,
  ) {}

  /**
   * Mints an access/refresh pair. `familyId` continues an existing rotation
   * chain; omit it to start a new one (i.e. a fresh login).
   */
  async issue(
    payload: Omit<AccessTokenPayload, 'typ'>,
    meta: { userAgent?: string; ip?: string },
    familyId?: string,
  ): Promise<IssuedTokens> {
    const accessToken = await this.jwt.signAsync({ ...payload, typ: 'access' });

    // 256 bits of CSPRNG entropy. Not a JWT: refresh tokens must be revocable,
    // and a stateless token cannot be revoked.
    const refreshToken = randomBytes(32).toString('base64url');
    const days = this.config.getOrThrow<number>('REFRESH_TOKEN_TTL_DAYS');

    await this.prisma.refreshToken.create({
      data: {
        userId: payload.sub,
        tokenHash: hashToken(refreshToken),
        familyId: familyId ?? randomUUID(),
        expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
        userAgent: meta.userAgent?.slice(0, 255),
        ipAddress: meta.ip,
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.getOrThrow<number>('JWT_ACCESS_TTL_SECONDS'),
    };
  }

  /**
   * Validates a refresh token and consumes it.
   *
   * Reuse detection: a token that has already been rotated away is either a
   * replay or a stolen copy. We cannot tell which, so we revoke the whole
   * family — the legitimate user gets logged out and must sign in again, which
   * is the correct trade against an attacker holding a valid session.
   */
  async rotate(
    presented: string,
  ): Promise<{ userId: string; familyId: string }> {
    const tokenHash = hashToken(presented);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!existing) throw new UnauthorizedException('Invalid refresh token');

    if (existing.revokedAt) {
      // The highest-signal event in the system: a rotated-away token came back.
      // Either a replay or a theft, and we cannot tell which.
      this.events.record({
        type: 'REFRESH_REUSE_DETECTED',
        userId: existing.userId,
        metadata: { familyId: existing.familyId },
      });
      await this.revokeFamily(existing.familyId);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (existing.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });

    return { userId: existing.userId, familyId: existing.familyId };
  }

  /**
   * Revokes the presented token and returns its family, so a caller can issue a
   * replacement inside the same session.
   *
   * Unlike rotate(), a token that is already revoked or expired is NOT treated
   * as theft here — this runs on an authenticated request where the access
   * token has already been verified, so the caller is who they claim to be. The
   * worst case is a slightly stale cookie, which does not warrant nuking the
   * user's session. Returns undefined so the caller starts a fresh family.
   */
  async rotateForReissue(presented: string): Promise<string | undefined> {
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(presented) },
    });
    if (!existing || existing.revokedAt) return undefined;

    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });
    return existing.familyId;
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Used on logout, and whenever a membership is revoked. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeByToken(presented: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(presented), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
