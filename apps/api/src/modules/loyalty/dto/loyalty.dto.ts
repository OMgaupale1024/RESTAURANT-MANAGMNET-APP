import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
} from 'class-validator';

/** Points are whole numbers, always — same integer discipline as money. */
const MAX_POINTS = 10_000_000;
/** ₹10,000,000 in paise — the same ceiling money uses across the app. */
const MAX_MINOR = 1_000_000_000;

/**
 * Spend points. `points` is the positive amount to redeem; the service records
 * it as a negative ledger entry. The server enforces the customer has enough —
 * a redemption can never drive the balance below zero.
 */
export class RedeemPointsDto {
  @IsInt()
  @IsPositive()
  @Max(MAX_POINTS)
  points!: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;

  /** Client-supplied so a retried redeem cannot double-spend. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string;
}

/**
 * The configurable loyalty rules an owner/manager saves (M13). Bounds here are
 * the trust boundary; LoyaltyService.validateConfig adds the cross-field sanity
 * checks (sane ratios, multiples), and the DB CHECKs are the final backstop.
 * Every field is required — the settings screen always sends the whole config —
 * except the optional per-order maximum (null = no ceiling).
 */
export class UpdateLoyaltySettingsDto {
  @IsBoolean()
  isEnabled!: boolean;

  @IsInt()
  @IsPositive()
  @Max(MAX_MINOR)
  earnAmountMinor!: number;

  @IsInt()
  @IsPositive()
  @Max(MAX_POINTS)
  earnPoints!: number;

  @IsInt()
  @IsPositive()
  @Max(MAX_POINTS)
  redeemPoints!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_MINOR)
  redeemAmountMinor!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_POINTS)
  minimumRedeemPoints!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_POINTS)
  maximumRedeemPointsPerOrder?: number | null;
}

/**
 * A manual correction or goodwill grant. Signed and non-zero: a positive value
 * awards points, a negative value deducts them. Reason is mandatory — a silent
 * points movement is the loyalty equivalent of a silent refund.
 */
export class AdjustPointsDto {
  @IsInt()
  @NotEquals(0)
  @Min(-MAX_POINTS)
  @Max(MAX_POINTS)
  points!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string;
}
