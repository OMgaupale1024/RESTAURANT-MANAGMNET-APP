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
import { PaymentMethod } from '../../../generated/prisma/enums';

/**
 * Records money RECEIVED against an order. Amount is the one thing the client
 * does state here — unlike prices, how a customer pays (₹200 cash + rest UPI)
 * is a fact only the counter knows. The server still enforces the ceiling:
 * captured payments can never exceed the order total.
 */
export class RecordPaymentDto {
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsInt()
  @Min(1)
  @Max(100_000_000)
  amountMinor!: number;

  /** Free-form: UPI ref, card last-4. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string;
}

/**
 * Records money handed BACK. Reason is mandatory: a silent refund is the
 * second-classic way money leaves a till (voids being the first — and this
 * route demands the same order.refund permission a void's big brother would).
 */
export class RecordRefundDto {
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsInt()
  @Min(1)
  @Max(100_000_000)
  amountMinor!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string;
}
