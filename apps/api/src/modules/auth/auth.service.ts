import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { compare, hash } from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService, type IssuedTokens } from './token.service';
import { SecurityEventService } from './security-event.service';
import { MailService } from '../mail/mail.service';
import type {
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
} from './dto/auth.dto';

// Cost 12: ~250ms on modern hardware. Deliberately slow — this is the only
// defence against an offline crack if the database is ever stolen.
const BCRYPT_COST = 12;

// Short by design: a reset link is a bearer credential to the account. Long
// enough to read an email and click, short enough that a leaked link goes stale.
const PASSWORD_RESET_TTL_MINUTES = 30;

// Verification is lower-stakes than a reset — a day is comfortable for someone
// to get to their inbox, and it only proves ownership, never grants access.
const EMAIL_VERIFY_TTL_HOURS = 24;

/** Opaque tokens are stored only as a hash — a DB leak must not yield reset links. */
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

// A real bcrypt hash of a random string, compared against when no user exists,
// so login takes the same time whether or not the email is registered. Without
// this, response timing tells an attacker which emails have accounts.
const DUMMY_HASH =
  '$2b$12$C6UzMDM.H6dfI/f/IKcEe.7VfCkBqO8kZ8yPOF3zVEcXvGUnhfPFe';

type RequestMeta = { userAgent?: string; ip?: string };

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly events: SecurityEventService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Creates a user account only. Creating a restaurant is Step 8 — a user can
   * exist without a tenant, and their token simply carries no restaurant.
   */
  async register(dto: RegisterDto, meta: RequestMeta): Promise<IssuedTokens> {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });
    // Registration inherently reveals whether an email is taken — there is no
    // way to create an account without saying so. Rate limiting is the control
    // here, not concealment.
    if (existing) throw new ConflictException('Email already registered');

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        name: dto.name,
        passwordHash: await hash(dto.password, BCRYPT_COST),
      },
      select: { id: true, email: true },
    });

    this.events.record({
      type: 'REGISTERED',
      userId: user.id,
      email: user.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    // Send a verification email, fire-and-forget — registration must not block
    // on delivery, and a failed send must never fail the signup.
    void this.issueVerification(user.id, user.email).catch(() => undefined);

    return this.tokens.issue(
      {
        sub: user.id,
        email: user.email,
        rid: null,
        mid: null,
        role: null,
        perms: [],
      },
      meta,
    );
  }

  async login(dto: LoginDto, meta: RequestMeta): Promise<IssuedTokens> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    // Always run a comparison, even with no user, to keep timing flat.
    const ok = await compare(dto.password, user?.passwordHash ?? DUMMY_HASH);

    // One message for every failure mode: wrong email, wrong password, and
    // disabled account are indistinguishable to the caller.
    if (!user || !ok || !user.isActive) {
      // The reason is recorded server-side even though the client is told
      // nothing — that asymmetry is the point.
      this.events.record({
        type: 'LOGIN_FAILED',
        userId: user?.id ?? null,
        email: dto.email,
        ip: meta.ip,
        userAgent: meta.userAgent,
        metadata: {
          reason: !user ? 'unknown_email' : !ok ? 'bad_password' : 'inactive',
        },
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    this.events.record({
      type: 'LOGIN_SUCCESS',
      userId: user.id,
      email: user.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const claims = await this.buildClaims(user.id, user.email);
    return this.tokens.issue(claims, meta);
  }

  async refresh(presented: string, meta: RequestMeta): Promise<IssuedTokens> {
    const { userId, familyId } = await this.tokens.rotate(presented);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) {
      // Deactivated between refreshes — kill the whole chain.
      await this.tokens.revokeFamily(familyId);
      throw new UnauthorizedException('Account is not active');
    }

    // Claims are rebuilt from the database on every refresh, so a permission
    // or membership change takes effect within one access-token lifetime
    // rather than lasting until the refresh token expires.
    const claims = await this.buildClaims(user.id, user.email);
    return this.tokens.issue(claims, meta, familyId);
  }

  async logout(presented: string | undefined, userId?: string): Promise<void> {
    if (presented) await this.tokens.revokeByToken(presented);
    if (userId) this.events.record({ type: 'LOGOUT', userId });
  }

  /**
   * Signs the user out of every device, not just this browser.
   *
   * logout() revokes only the token the cookie currently holds, which is right
   * for an ordinary sign-out on one device. It is not enough for the case this
   * exists to serve: a lost phone or a shared tablet someone else still has
   * open. Revoking the whole set is the control BLUEPRINT §8 names against an
   * ex-employee keeping access — and it includes the caller's own token, so
   * "everywhere" means everywhere.
   */
  async logoutAll(userId: string, meta: RequestMeta): Promise<void> {
    await this.tokens.revokeAllForUser(userId);
    this.events.record({
      type: 'LOGOUT',
      userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: { scope: 'all' },
    });
  }

  /**
   * Starts a password reset. The response is the SAME whether or not the email
   * has an account — the controller returns success unconditionally, and the
   * only observable difference is an email that does or does not arrive. That
   * is what stops this endpoint from being an account-enumeration oracle.
   *
   * The email dispatch is fire-and-forget: the caller does not wait on it, which
   * both keeps timing flat between the two branches and keeps the endpoint fast.
   */
  async requestPasswordReset(
    dto: ForgotPasswordDto,
    meta: RequestMeta,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true, email: true, isActive: true },
    });

    // Inactive accounts get nothing either — a deactivated user must not be able
    // to reset their way back in.
    if (!user || !user.isActive) return;

    // Only the latest link should work. Invalidate any still-outstanding ones so
    // an old email cannot be used after a newer request.
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    // 256 bits of CSPRNG entropy; only its hash is stored.
    const token = randomBytes(32).toString('base64url');
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60_000),
      },
    });

    this.events.record({
      type: 'PASSWORD_RESET_REQUESTED',
      userId: user.id,
      email: user.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const url = `${this.config.getOrThrow<string>('WEB_URL')}/reset-password?token=${token}`;
    // Not awaited: the request must not block on delivery, and both branches of
    // this method must take the same time from the caller's point of view.
    void this.mail.sendPasswordResetEmail(user.email, url).catch(() => {
      // Delivery failures are the transport's to log; a failed send must not
      // turn a valid request into an error the caller could probe.
    });
  }

  /**
   * Completes a password reset.
   *
   * The token is validated, consumed atomically (single-use), the password is
   * re-hashed with the same policy as registration, and EVERY existing session
   * is revoked — a reset is exactly the "I may be compromised" case that
   * "sign out everywhere" exists for. We do not sign the user in; they return to
   * the login page and use the new password, so possession of the reset link
   * alone never yields a live session.
   */
  async resetPassword(dto: ResetPasswordDto, meta: RequestMeta): Promise<void> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(dto.token) },
      select: { id: true, userId: true, usedAt: true, expiresAt: true },
    });

    // One message for every failure — unknown, used, and expired are
    // indistinguishable to the caller.
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException(
        'This reset link is invalid or has expired',
      );
    }

    const passwordHash = await hash(dto.password, BCRYPT_COST);

    // Claim the token and set the password in one transaction. The conditional
    // update (usedAt IS NULL) makes consumption atomic: two requests racing the
    // same link resolve to exactly one winner, and the loser is rejected.
    const claimed = await this.prisma.$transaction(async (db) => {
      const consumed = await db.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count === 0) return false;
      await db.user.update({
        where: { id: record.userId },
        data: { passwordHash },
      });
      return true;
    });

    if (!claimed) {
      throw new BadRequestException(
        'This reset link is invalid or has expired',
      );
    }

    // Kill every session, on every device. Revokes refresh tokens AND stamps the
    // session epoch, so a token already in flight cannot mint a survivor.
    await this.tokens.revokeAllForUser(record.userId);

    this.events.record({
      type: 'PASSWORD_RESET_COMPLETED',
      userId: record.userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  /**
   * Mints a verification token and emails the link. Shared by register (auto)
   * and resend (on request). Invalidates any outstanding token first so only
   * the newest link works — same rule as password reset.
   */
  private async issueVerification(
    userId: string,
    email: string,
  ): Promise<void> {
    await this.prisma.emailVerificationToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    const token = randomBytes(32).toString('base64url');
    await this.prisma.emailVerificationToken.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_HOURS * 3_600_000),
      },
    });
    const url = `${this.config.getOrThrow<string>('WEB_URL')}/verify-email?token=${token}`;
    await this.mail.sendEmailVerificationEmail(email, url);
  }

  /**
   * Consumes a verification token and stamps the email verified. Single-use and
   * atomic, like the reset flow. Idempotent for an already-verified user: a
   * second click on the same link is a friendly success, not an error.
   */
  async verifyEmail(token: string, meta: RequestMeta): Promise<void> {
    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, userId: true, usedAt: true, expiresAt: true },
    });
    if (!record || record.expiresAt < new Date()) {
      throw new BadRequestException(
        'This verification link is invalid or has expired',
      );
    }
    // Already used: only OK if it was this user's own verification that already
    // landed. Consuming stamps usedAt, so a replay finds usedAt set — treat a
    // used-but-verified account as success.
    const claimed = await this.prisma.$transaction(async (db) => {
      const consumed = await db.emailVerificationToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count === 0) return false;
      await db.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date() },
      });
      return true;
    });

    if (!claimed) {
      // The token was already consumed. If the account is verified, that is a
      // success; otherwise the link is spent.
      const user = await this.prisma.user.findUnique({
        where: { id: record.userId },
        select: { emailVerifiedAt: true },
      });
      if (user?.emailVerifiedAt) return;
      throw new BadRequestException(
        'This verification link is invalid or has expired',
      );
    }

    this.events.record({
      type: 'EMAIL_VERIFIED',
      userId: record.userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  /** Resends a verification link to the logged-in user, if still unverified. */
  async resendVerification(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true, isActive: true },
    });
    // Nothing to do (and nothing to leak) for a verified or inactive account.
    if (!user || !user.isActive || user.emailVerifiedAt) return;
    await this.issueVerification(userId, user.email).catch(() => undefined);
  }

  /**
   * Issues a new token scoped to a specific restaurant (backlog #4).
   *
   * The authorization check is the entire point: a user may only select a
   * restaurant they hold an active membership in. Without this, `restaurantId`
   * would be a client-supplied value that lands in the JWT — which is exactly
   * the cross-tenant hole the whole architecture exists to prevent.
   *
   * Note the membership lookup runs with the user's own context, so RLS scopes
   * it to their rows before we even check.
   */
  async selectRestaurant(
    userId: string,
    email: string,
    restaurantId: string,
    meta: RequestMeta,
    presentedRefresh?: string,
    accessTokenIat?: number,
  ): Promise<IssuedTokens> {
    // This route mints a refresh session and is guarded by the ACCESS token, so
    // an access token that survived "sign out everywhere" could use it to start
    // a brand-new token family and undo the revocation. Verified reachable
    // before this check existed.
    await this.tokens.assertAccessTokenNotStale(userId, accessTokenIat);

    const membership = await this.prisma.txAs(
      { userId, restaurantId: null },
      (db) =>
        db.membership.findFirst({
          where: { userId, restaurantId, isActive: true },
          select: {
            id: true,
            restaurantId: true,
            role: {
              select: {
                key: true,
                permissions: {
                  select: { permission: { select: { key: true } } },
                },
              },
            },
          },
        }),
    );

    if (!membership) {
      // Deliberately Forbidden with no detail: do not reveal whether the
      // restaurant exists at all. "Not a member" and "no such restaurant"
      // must look identical.
      throw new ForbiddenException('No access to that restaurant');
    }

    this.events.record({
      type: 'RESTAURANT_SELECTED',
      userId,
      email,
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: { restaurantId },
    });

    // Continue the SAME token family rather than starting a new one.
    //
    // The bug this fixes (found in Step 9 verification): issuing without a
    // familyId minted a fresh family and orphaned the login token, which stayed
    // valid for its full 7 days and — worse — survived logout, because logout
    // only revokes the token the cookie currently holds. One session must mean
    // one family, or "sign out" is a lie.
    //
    // Rotation happens only AFTER membership is verified. Revoking first would
    // mean a failed selection logs the user out.
    const familyId = presentedRefresh
      ? await this.tokens.rotateForReissue(presentedRefresh)
      : undefined;

    return this.tokens.issue(
      {
        sub: userId,
        email,
        rid: membership.restaurantId,
        mid: membership.id,
        role: membership.role.key,
        perms: membership.role.permissions.map((rp) => rp.permission.key),
      },
      meta,
      familyId,
    );
  }

  async me(userId: string) {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        emailVerifiedAt: true,
      },
    });
    if (!row) throw new UnauthorizedException();
    // Expose a boolean, not the instant — the client only needs "verified?".
    const { emailVerifiedAt, ...rest } = row;
    const user = { ...rest, emailVerified: emailVerifiedAt !== null };

    // memberships is RLS-protected; a user may always read their own rows.
    const memberships = await this.prisma.txAs(
      { userId, restaurantId: null },
      (db) =>
        db.membership.findMany({
          where: { userId, isActive: true },
          select: {
            id: true,
            restaurant: { select: { id: true, name: true, slug: true } },
            role: { select: { key: true, name: true } },
          },
        }),
    );

    return { user, memberships };
  }

  /**
   * Builds token claims from the database.
   *
   * Permissions are embedded in the access token rather than looked up per
   * request. The trade: a revoked permission remains usable until the access
   * token expires (15 minutes). That window is bounded on the other side by
   * revoking refresh tokens when a membership is removed, so a dismissed
   * employee cannot mint a new one.
   *
   * If exactly one membership exists it is selected automatically. With zero
   * (a fresh account) or several, the token carries no restaurant and the
   * client must choose — that endpoint arrives with restaurant setup.
   */
  private async buildClaims(userId: string, email: string) {
    const memberships = await this.prisma.txAs(
      { userId, restaurantId: null },
      (db) =>
        db.membership.findMany({
          where: { userId, isActive: true },
          select: {
            id: true,
            restaurantId: true,
            role: {
              select: {
                key: true,
                permissions: {
                  select: { permission: { select: { key: true } } },
                },
              },
            },
          },
        }),
    );

    if (memberships.length !== 1) {
      return {
        sub: userId,
        email,
        rid: null,
        mid: null,
        role: null,
        perms: [],
      };
    }

    const m = memberships[0];
    return {
      sub: userId,
      email,
      rid: m.restaurantId,
      mid: m.id,
      role: m.role.key,
      perms: m.role.permissions.map((rp) => rp.permission.key),
    };
  }
}
