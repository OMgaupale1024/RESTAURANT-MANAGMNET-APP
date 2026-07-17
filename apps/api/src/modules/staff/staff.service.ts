import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash } from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService, type TxClient } from '../../prisma/prisma.service';
import { SecurityEventService } from '../auth/security-event.service';
import { TokenService, type IssuedTokens } from '../auth/token.service';
import type {
  AcceptInviteDto,
  ClockDto,
  CreateInviteDto,
  TimesheetQuery,
  UpdateMemberDto,
} from './dto/staff.dto';

const BCRYPT_COST = 12;
const INVITE_TTL_DAYS = 7;

/** Same discipline as refresh tokens: a leak must not yield usable invites. */
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly events: SecurityEventService,
    private readonly config: ConfigService,
  ) {}

  /** Everyone who works here, with their current on-shift state. */
  async list() {
    return this.prisma.tx(async (db) => {
      const members = await db.membership.findMany({
        select: {
          id: true,
          isActive: true,
          createdAt: true,
          user: { select: { id: true, name: true, email: true } },
          role: { select: { key: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      });

      // On-shift is DERIVED from the latest event, never stored. A flag would
      // drift the first time a clock-out was missed.
      const latest = await this.latestEventByMembership(
        db,
        members.map((m) => m.id),
      );

      return members.map((m) => ({
        ...m,
        onShift: latest.get(m.id)?.type === 'CLOCK_IN',
        lastEventAt: latest.get(m.id)?.at ?? null,
      }));
    });
  }

  async listInvites() {
    return this.prisma.tx((db) =>
      db.staffInvite.findMany({
        where: {
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: {
          id: true,
          email: true,
          expiresAt: true,
          createdAt: true,
          role: { select: { key: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /**
   * Creates an invitation and returns the link ONCE.
   *
   * The raw token is never stored and never retrievable again — same contract
   * as a refresh token. If the owner loses the link they revoke and reissue.
   */
  async createInvite(dto: CreateInviteDto) {
    const ctx = this.prisma.requireContext();

    const role = await this.prisma.role.findUnique({
      where: { key: dto.role },
      select: { id: true },
    });
    if (!role) throw new BadRequestException('Unknown role');

    const token = randomBytes(32).toString('base64url');

    return this.prisma.tx(async (db) => {
      // Someone already on the team does not need an invitation.
      const existing = await db.membership.findFirst({
        where: { user: { email: dto.email } },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException('That person is already on your team');
      }

      try {
        const invite = await db.staffInvite.create({
          data: {
            restaurantId: ctx.restaurantId,
            email: dto.email,
            roleId: role.id,
            tokenHash: hashToken(token),
            expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
            invitedBy: ctx.userId,
          },
          select: { id: true, email: true, expiresAt: true },
        });

        await db.auditLog.create({
          data: {
            restaurantId: ctx.restaurantId,
            userId: ctx.userId,
            action: 'staff.invited',
            entityType: 'staff_invite',
            entityId: invite.id,
            metadata: { email: dto.email, role: dto.role },
          },
        });

        return {
          ...invite,
          role: dto.role,
          // Shown once. The owner shares it however they already talk to staff.
          inviteUrl: `${this.config.getOrThrow<string>('WEB_URL')}/join/${token}`,
        };
      } catch (e) {
        if ((e as { code?: string })?.code === 'P2002') {
          throw new ConflictException(
            'An invite for that email is already pending',
          );
        }
        throw e;
      }
    });
  }

  async revokeInvite(id: string) {
    const ctx = this.prisma.requireContext();
    return this.prisma.tx(async (db) => {
      const invite = await db.staffInvite.findFirst({
        where: { id, acceptedAt: null, revokedAt: null },
        select: { id: true },
      });
      if (!invite) throw new NotFoundException('Invite not found');

      await db.staffInvite.update({
        where: { id },
        data: { revokedAt: new Date() },
      });
      await db.auditLog.create({
        data: {
          restaurantId: ctx.restaurantId,
          userId: ctx.userId,
          action: 'staff.invite_revoked',
          entityType: 'staff_invite',
          entityId: id,
        },
      });
      return { revoked: true };
    });
  }

  /**
   * PUBLIC — describes an invite so the join page can render.
   *
   * Deliberately minimal: the restaurant name and the role, nothing about who
   * else works there. Anyone holding the link can see this, and the link may
   * have been forwarded.
   */
  async describeInvite(token: string) {
    const invite = await this.findValidInvite(token);

    // Two steps, deliberately. The token authorises reading the invite; the
    // invite then tells us which tenant to become in order to read the
    // restaurant's name. Joining `restaurant` in the first query returns null,
    // because the restaurants policy needs a tenant context this caller does
    // not have — cascading RLS, and the reason this is not one query.
    const restaurant = await this.prisma.txAs(
      { userId: '', restaurantId: invite.restaurantId },
      (db) =>
        db.restaurant.findFirstOrThrow({
          where: { id: invite.restaurantId },
          select: { name: true },
        }),
    );

    return {
      email: invite.email,
      restaurantName: restaurant.name,
      role: invite.role,
      expiresAt: invite.expiresAt,
    };
  }

  /**
   * Reads an invite by its token and asserts it is usable.
   *
   * One error for every failure — expired, revoked, already used, and
   * never-existed are indistinguishable, so a token cannot be probed.
   */
  private async findValidInvite(token: string) {
    const tokenHash = hashToken(token);

    // RLS on staff_invites is satisfied by the token itself: the policy grants
    // exactly the row whose hash matches. Possession IS the authorization.
    const invite = await this.prisma.txWithInvite(tokenHash, (db) =>
      db.staffInvite.findFirst({
        where: { tokenHash },
        select: {
          id: true,
          email: true,
          restaurantId: true,
          roleId: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
          role: {
            select: {
              key: true,
              name: true,
              permissions: {
                select: { permission: { select: { key: true } } },
              },
            },
          },
        },
      }),
    );

    if (
      !invite ||
      invite.acceptedAt ||
      invite.revokedAt ||
      invite.expiresAt < new Date()
    ) {
      throw new NotFoundException('This invitation is no longer valid');
    }
    return invite;
  }

  /**
   * PUBLIC — accepts an invitation: creates the user and their membership.
   *
   * The invitee sets their own password. Nobody else, including the owner, ever
   * knows it — which is what keeps the audit trail attributable.
   *
   * Note the email is taken from the INVITE, never from the request. Otherwise
   * a forwarded link would let anyone join under any address.
   */
  async acceptInvite(
    token: string,
    dto: AcceptInviteDto,
    meta: { ip?: string; userAgent?: string },
  ): Promise<IssuedTokens> {
    const invite = await this.findValidInvite(token);

    const existingUser = await this.prisma.user.findUnique({
      where: { email: invite.email },
      select: { id: true },
    });
    if (existingUser) {
      // Someone already has an account with this address. Joining a second
      // restaurant is a real case, but it must be done while signed in as
      // themselves — not by setting a new password through a link.
      throw new ConflictException(
        'An account with that email already exists. Sign in first.',
      );
    }

    const passwordHash = await hash(dto.password, BCRYPT_COST);

    const { userId, membershipId } = await this.prisma.txAs(
      { userId: '', restaurantId: invite.restaurantId },
      async (db) => {
        // Consume the invite inside the transaction. Two people racing the same
        // link: one wins, the other finds it accepted.
        const consumed = await db.staffInvite.updateMany({
          where: { id: invite.id, acceptedAt: null, revokedAt: null },
          data: { acceptedAt: new Date() },
        });
        if (consumed.count === 0) {
          throw new NotFoundException('This invitation is no longer valid');
        }

        const user = await db.user.create({
          data: { email: invite.email, name: dto.name, passwordHash },
          select: { id: true },
        });
        const membership = await db.membership.create({
          data: {
            userId: user.id,
            restaurantId: invite.restaurantId,
            roleId: invite.roleId,
          },
          select: { id: true },
        });

        await db.auditLog.create({
          data: {
            restaurantId: invite.restaurantId,
            userId: user.id,
            action: 'staff.joined',
            entityType: 'membership',
            entityId: membership.id,
            metadata: { email: invite.email, role: invite.role.key },
          },
        });

        return { userId: user.id, membershipId: membership.id };
      },
    );

    this.events.record({
      type: 'REGISTERED',
      userId,
      email: invite.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: { via: 'staff_invite' },
    });

    // Signed straight in, scoped to the restaurant they just joined.
    return this.tokens.issue(
      {
        sub: userId,
        email: invite.email,
        rid: invite.restaurantId,
        mid: membershipId,
        role: invite.role.key,
        perms: invite.role.permissions.map((rp) => rp.permission.key),
      },
      meta,
    );
  }

  /** Change a member's role, or deactivate them. */
  async updateMember(membershipId: string, dto: UpdateMemberDto) {
    const ctx = this.prisma.requireContext();

    return this.prisma.tx(async (db) => {
      const member = await db.membership.findFirst({
        where: { id: membershipId },
        select: {
          id: true,
          userId: true,
          role: { select: { key: true } },
        },
      });
      if (!member) throw new NotFoundException('Staff member not found');

      // An owner cannot be demoted or disabled through this route. Otherwise
      // a manager could remove the owner, or an owner could lock themselves
      // out of their own restaurant.
      if (member.role.key === 'OWNER') {
        throw new ForbiddenException('The owner cannot be changed here');
      }
      // Belt and braces: nobody edits their own membership.
      if (member.userId === ctx.userId) {
        throw new ForbiddenException('You cannot change your own access');
      }

      const data: { roleId?: string; isActive?: boolean } = {};
      if (dto.role) {
        const role = await db.role.findUnique({
          where: { key: dto.role },
          select: { id: true },
        });
        if (!role) throw new BadRequestException('Unknown role');
        data.roleId = role.id;
      }
      if (dto.isActive !== undefined) data.isActive = dto.isActive;
      if (!Object.keys(data).length) {
        throw new BadRequestException('Nothing to change');
      }

      const updated = await db.membership.update({
        where: { id: membershipId },
        data,
        select: {
          id: true,
          isActive: true,
          user: { select: { id: true, name: true, email: true } },
          role: { select: { key: true, name: true } },
        },
      });

      await db.auditLog.create({
        data: {
          restaurantId: ctx.restaurantId,
          userId: ctx.userId,
          action:
            dto.isActive === false ? 'staff.deactivated' : 'staff.updated',
          entityType: 'membership',
          entityId: membershipId,
          metadata: { role: dto.role ?? null, isActive: dto.isActive ?? null },
        },
      });

      return updated;
    });
  }

  /**
   * Clock in or out.
   *
   * Two rules that matter:
   *  - Recording for SOMEONE ELSE, or backdating, requires attendance.manage.
   *    Otherwise a cashier could write their own hours.
   *  - The state machine is enforced: you cannot clock in twice. Timekeeping
   *    with unbalanced events is unpayable.
   */
  async clock(targetMembershipId: string | null, dto: ClockDto) {
    const ctx = this.prisma.requireContext();
    const forSelf =
      !targetMembershipId || targetMembershipId === ctx.membershipId;
    const canManage = ctx.permissions.includes('attendance.manage');

    if (!forSelf && !canManage) {
      throw new ForbiddenException('Missing permission: attendance.manage');
    }
    // Backdating your own hours is the timesheet equivalent of editing a
    // receipt after the fact.
    if (dto.at && !canManage) {
      throw new ForbiddenException('Cannot backdate your own attendance');
    }

    const membershipId = targetMembershipId ?? ctx.membershipId;
    if (!membershipId)
      throw new BadRequestException('No membership in context');

    const at = dto.at ? new Date(dto.at) : new Date();
    if (at.getTime() > Date.now() + 60_000) {
      throw new BadRequestException(
        'Attendance cannot be recorded in the future',
      );
    }

    return this.prisma.tx(async (db) => {
      const membership = await db.membership.findFirst({
        where: { id: membershipId },
        select: { id: true, isActive: true },
      });
      // Another tenant's membership does not exist here.
      if (!membership) throw new NotFoundException('Staff member not found');
      if (!membership.isActive) {
        throw new BadRequestException('That staff member is not active');
      }

      const last = await db.attendanceEvent.findFirst({
        where: { membershipId },
        orderBy: { at: 'desc' },
        select: { type: true },
      });

      if (last?.type === dto.type) {
        throw new ConflictException(
          dto.type === 'CLOCK_IN'
            ? 'Already clocked in'
            : 'Already clocked out',
        );
      }
      if (!last && dto.type === 'CLOCK_OUT') {
        throw new ConflictException('Not clocked in');
      }

      return db.attendanceEvent.create({
        data: {
          restaurantId: ctx.restaurantId,
          membershipId,
          type: dto.type,
          at,
          // Null when clocking yourself in; set when someone did it for you.
          // The difference matters in a dispute.
          recordedBy: forSelf ? null : ctx.userId,
          note: dto.note ?? null,
        },
        select: { id: true, type: true, at: true, recordedBy: true },
      });
    });
  }

  /**
   * Hours worked, derived by pairing events.
   *
   * Nothing is stored. An unpaired CLOCK_IN (someone still on shift, or who
   * forgot to clock out) is reported as an open session rather than silently
   * given an end time — a guessed end time is a guessed wage.
   */
  async timesheet(query: TimesheetQuery) {
    const from = query.from
      ? new Date(query.from)
      : new Date(Date.now() - 7 * 86_400_000);
    const to = query.to ? new Date(query.to) : new Date();

    return this.prisma.tx(async (db) => {
      const events = await db.attendanceEvent.findMany({
        where: {
          at: { gte: from, lte: to },
          ...(query.membershipId ? { membershipId: query.membershipId } : {}),
        },
        orderBy: { at: 'asc' },
        select: {
          id: true,
          membershipId: true,
          type: true,
          at: true,
          recordedBy: true,
          note: true,
        },
      });

      const members = await db.membership.findMany({
        where: query.membershipId ? { id: query.membershipId } : undefined,
        select: {
          id: true,
          user: { select: { name: true } },
          role: { select: { key: true } },
        },
      });

      return members.map((m) => {
        const mine = events.filter((e) => e.membershipId === m.id);
        const sessions: Array<{
          in: Date;
          out: Date | null;
          minutes: number | null;
        }> = [];
        let openIn: Date | null = null;

        for (const e of mine) {
          if (e.type === 'CLOCK_IN') {
            openIn = e.at;
          } else if (openIn) {
            sessions.push({
              in: openIn,
              out: e.at,
              minutes: Math.round((e.at.getTime() - openIn.getTime()) / 60_000),
            });
            openIn = null;
          }
        }
        // Still on shift, or a forgotten clock-out. Reported, not guessed.
        if (openIn) sessions.push({ in: openIn, out: null, minutes: null });

        return {
          membershipId: m.id,
          name: m.user.name,
          role: m.role.key,
          sessions,
          totalMinutes: sessions.reduce((s, x) => s + (x.minutes ?? 0), 0),
          openSession: sessions.some((s) => s.out === null),
        };
      });
    });
  }

  private async latestEventByMembership(db: TxClient, membershipIds: string[]) {
    if (!membershipIds.length)
      return new Map<string, { type: string; at: Date }>();
    const events = await db.attendanceEvent.findMany({
      where: { membershipId: { in: membershipIds } },
      orderBy: { at: 'desc' },
      select: { membershipId: true, type: true, at: true },
    });
    const latest = new Map<string, { type: string; at: Date }>();
    for (const e of events) {
      if (!latest.has(e.membershipId)) {
        latest.set(e.membershipId, { type: e.type, at: e.at });
      }
    }
    return latest;
  }
}
