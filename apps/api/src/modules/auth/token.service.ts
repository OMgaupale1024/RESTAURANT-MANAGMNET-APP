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

    await this.assertSessionNotRevoked(existing.userId, existing.familyId);

    // Conditional, not a blind update: a concurrent logout-all may have revoked
    // this token between the read above and here. Matching on revokedAt IS NULL
    // makes claiming it atomic, so the loser never goes on to mint a
    // replacement. Two simultaneous refreshes of the same token also resolve to
    // exactly one winner.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw new UnauthorizedException('Invalid refresh token');
    }

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

  /**
   * Enforces the session epoch: a token FAMILY that began before the user last
   * signed out everywhere is dead, whatever the age of the individual token.
   *
   * The family, not the token, is the unit — and that is the whole fix. A
   * refresh already in flight when logout-all runs inserts its replacement
   * AFTER the revocation swept, so the replacement is younger than the epoch
   * and a per-token check would wave it through. It is still a rotation of the
   * same login, so its family predates the epoch and it is refused here. A
   * fresh login starts a new family after the epoch and is unaffected.
   */
  private async assertSessionNotRevoked(
    userId: string,
    familyId: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { sessionsValidFrom: true },
    });
    // Null means the user has never signed out everywhere.
    if (!user?.sessionsValidFrom) return;

    const family = await this.prisma.refreshToken.aggregate({
      where: { familyId },
      _min: { createdAt: true },
    });
    const startedAt = family._min.createdAt;
    if (startedAt && startedAt < user.sessionsValidFrom) {
      // Tidy up so the dead family stops being presented on every reload.
      await this.revokeFamily(familyId);
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Ends every session for a user: revokes the tokens that exist now, AND
   * stamps the session epoch so the ones that do not yet exist are refused too.
   *
   * Both statements commit together. The sweep alone cannot bind a refresh that
   * is already in flight — that request inserts its replacement token after the
   * sweep has run, so the sweep never sees it. The epoch binds the future
   * instead; assertSessionNotRevoked() above is where it is enforced.
   */
  async revokeAllForUser(userId: string): Promise<void> {
    const at = new Date();
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { sessionsValidFrom: at },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: at },
      }),
    ]);
  }

  async revokeByToken(presented: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(presented), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
