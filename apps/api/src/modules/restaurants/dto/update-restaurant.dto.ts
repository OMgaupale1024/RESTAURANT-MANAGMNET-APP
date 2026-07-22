import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Every field optional; only the ones present are written. For the nullable
 * profile fields an EMPTY string means "clear it" — the transform turns '' into
 * null, IsOptional then skips validation, and the service writes the null.
 * That is how a form clears a GSTIN without a special "delete" affordance.
 */
const emptyToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t === '' ? null : t;
};

const digitsOrNull = ({ value }: { value: unknown }) => {
  const v = emptyToNull({ value });
  return typeof v === 'string' ? v.replace(/[^0-9]/g, '') : v;
};

const upperOrNull = ({ value }: { value: unknown }) => {
  const v = emptyToNull({ value });
  return typeof v === 'string' ? v.toUpperCase() : v;
};

export class UpdateRestaurantDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Transform(emptyToNull)
  address?: string | null;

  /** Digits only, 7–15 — same rule as customer phones. */
  @IsOptional()
  @Matches(/^[0-9]{7,15}$/, { message: 'phone must be 7-15 digits' })
  @Transform(digitsOrNull)
  phone?: string | null;

  /** Standard 15-character GSTIN, e.g. 27AAPFU0939F1ZV. */
  @IsOptional()
  @Matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/, {
    message: 'GSTIN must be a valid 15-character registration number',
  })
  @Transform(upperOrNull)
  gstin?: string | null;

  /** 14-digit FSSAI licence number. */
  @IsOptional()
  @Matches(/^[0-9]{14}$/, { message: 'FSSAI licence must be 14 digits' })
  @Transform(digitsOrNull)
  fssai?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(emptyToNull)
  receiptHeader?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Transform(emptyToNull)
  receiptFooter?: string | null;
}
