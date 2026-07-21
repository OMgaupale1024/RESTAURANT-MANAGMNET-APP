import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** 100,000,000 paise = ₹10,00,000 — a ceiling that catches a fat-fingered float. */
const MAX_CASH = 100_000_000;

export class OpenSessionDto {
  @IsInt()
  @Min(0)
  @Max(MAX_CASH)
  openingFloatMinor!: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export enum CashMovementKind {
  PAY_IN = 'PAY_IN',
  PAY_OUT = 'PAY_OUT',
}

export class CashMovementDto {
  @IsEnum(CashMovementKind)
  type!: CashMovementKind;

  @IsInt()
  @Min(1)
  @Max(MAX_CASH)
  amountMinor!: number;

  /** Mandatory: a drawer movement with no reason is how a till leaks. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reason!: string;
}

export class CloseSessionDto {
  /** The physically counted cash in the drawer. */
  @IsInt()
  @Min(0)
  @Max(MAX_CASH)
  closingCountedMinor!: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}
