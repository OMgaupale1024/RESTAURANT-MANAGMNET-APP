import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AttendanceEventType } from '../../../generated/prisma/enums';

/**
 * Roles a restaurant may hand out.
 *
 * OWNER is deliberately absent. Inviting a second owner is a privilege
 * escalation path — an invite is a link that can be forwarded, and an owner can
 * remove the original owner. Ownership transfer deserves its own deliberate
 * flow, not a dropdown.
 */
export enum InvitableRole {
  MANAGER = 'MANAGER',
  CASHIER = 'CASHIER',
  KITCHEN = 'KITCHEN',
}

export class CreateInviteDto {
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }) => String(value).trim().toLowerCase())
  email!: string;

  @IsEnum(InvitableRole, { message: 'must be MANAGER, CASHIER or KITCHEN' })
  role!: InvitableRole;
}

export class AcceptInviteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  name!: string;

  // Same rules as registration — length beats complexity, and bcrypt
  // silently truncates past 72 bytes.
  @IsString()
  @MinLength(12, { message: 'must be at least 12 characters' })
  @MaxLength(72)
  password!: string;
}

export class UpdateMemberDto {
  /** Role change. OWNER is not assignable here, same reasoning as invites. */
  @IsOptional()
  @IsEnum(InvitableRole)
  role?: InvitableRole;

  /** Deactivate rather than delete: their orders and attendance must survive. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ClockDto {
  @IsEnum(AttendanceEventType)
  type!: AttendanceEventType;

  /**
   * Optional backdate, for a manager correcting a forgotten clock-out.
   * Requires attendance.manage — see the service.
   */
  @IsOptional()
  @IsDateString()
  at?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class TimesheetQuery {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => String)
  @IsString()
  membershipId?: string;
}
