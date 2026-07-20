import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { compare, hash } from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService, type IssuedTokens } from './token.service';
import { SecurityEventService } from './security-event.service';
import type { LoginDto, RegisterDto } from './dto/auth.dto';

// Cost 12: ~250ms on modern hardware. Deliberately slow — this is the only
// defence against an offline crack if the database is ever stolen.
const BCRYPT_COST = 12;

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
  ): Promise<IssuedTokens> {
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
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, createdAt: true },
    });
    if (!user) throw new UnauthorizedException();

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
