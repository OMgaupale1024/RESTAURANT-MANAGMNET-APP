import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CouponType } from '../../../generated/prisma/enums';

/**
 * A coupon's value is one of two shapes; the DB CHECK enforces exactly-one, and
 * the service re-validates. The client never sends a discount amount for an
 * order — only the code — so a coupon can never be used to set an arbitrary
 * discount.
 */
export class CreateCouponDto {
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  // Codes are case-insensitive: stored and compared uppercase.
  @Transform(({ value }) => String(value).trim().toUpperCase())
  @Matches(/^[A-Z0-9]+$/, { message: 'code must be letters and numbers only' })
  code!: string;

  @IsEnum(CouponType)
  type!: CouponType;

  /** PERCENT only: basis points, 1000 = 10%. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  percentBp?: number;

  /** FIXED only: paise. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  amountMinor?: number;

  /** Optional cap on a PERCENT discount, paise. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  maxDiscountMinor?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  minSubtotalMinor?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxRedemptions?: number;

  @IsOptional()
  @IsISO8601()
  validFrom?: string;

  @IsOptional()
  @IsISO8601()
  validUntil?: string;
}

export class UpdateCouponDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
