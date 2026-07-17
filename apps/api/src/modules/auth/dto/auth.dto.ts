import {
  IsEmail,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class RegisterDto {
  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(254)
  // Normalised here so it satisfies the users_email_lowercase CHECK constraint.
  @Transform(({ value }) => String(value).trim().toLowerCase())
  email!: string;

  // 12 rather than the customary 8: length beats complexity rules, and this is
  // a business owner's payroll and revenue data.
  @IsString()
  @MinLength(12, { message: 'must be at least 12 characters' })
  // bcrypt silently truncates beyond 72 bytes; rejecting is honest.
  @MaxLength(72, { message: 'must be at most 72 characters' })
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  name!: string;
}

export class SelectRestaurantDto {
  // A UUID from the client is fine here precisely because the server verifies
  // membership before it ever reaches a token. It is a request, not a claim.
  @IsUUID()
  restaurantId!: string;
}

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }) => String(value).trim().toLowerCase())
  email!: string;

  @IsString()
  @MaxLength(72)
  password!: string;
}
