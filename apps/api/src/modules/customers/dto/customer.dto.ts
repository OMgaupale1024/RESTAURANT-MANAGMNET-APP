import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { normalizePhone } from '../phone';

/**
 * Phone is normalised before validation so "+91 98765-43210" and "9876543210"
 * become the SAME record rather than two people. Uses the one shared
 * normaliser — if the write path and the lookup path normalise differently,
 * phone stops being an identity. The database CHECK enforces the digits-only
 * shape: this is the convenience, that is the guarantee.
 */
const toDigits = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? normalizePhone(value) : value;

export class CreateCustomerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  name!: string;

  @IsString()
  @Transform(toDigits)
  @Matches(/^[0-9]{7,15}$/, {
    message: 'must be 7-15 digits',
  })
  phone!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }) =>
    value ? String(value).trim().toLowerCase() : undefined,
  )
  email?: string;

  // Date only. A birthday is not an instant and must not acquire a timezone.
  @IsOptional()
  @IsDateString({ strict: false })
  birthday?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/** Same fields, all optional. Phone stays changeable — people switch numbers. */
export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  name?: string;

  @IsOptional()
  @IsString()
  @Transform(toDigits)
  @Matches(/^[0-9]{7,15}$/, { message: 'must be 7-15 digits' })
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }) =>
    value ? String(value).trim().toLowerCase() : undefined,
  )
  email?: string;

  @IsOptional()
  @IsDateString({ strict: false })
  birthday?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class FindCustomersQuery {
  /** Matches name or phone. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  q?: string;

  @IsOptional()
  @Type(() => Number)
  limit?: number;
}
