import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Deliberately small. The blueprint's full onboarding wizard (logo, cuisine,
 * GST, working hours, tables, theme) is not here: logo needs object storage,
 * and the rest are settings that can be edited later. What a restaurant
 * genuinely cannot exist without is a name and somewhere to sell from.
 *
 * Note there is no restaurantId field — and never will be. The tenant is
 * created here and thereafter comes from the JWT.
 */
export class CreateRestaurantDto {
  @IsString()
  @MinLength(2, { message: 'must be at least 2 characters' })
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  name!: string;

  /** First branch. Every restaurant has at least one, even single-location. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  branchName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }) => String(value).trim())
  branchAddress?: string;
}
