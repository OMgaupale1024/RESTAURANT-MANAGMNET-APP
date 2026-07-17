import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Note what is absent: restaurantId. It comes from the JWT, always.
 * Prices are integer minor units (paise) — no floats reach this API.
 */
export class CreateProductDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  name!: string;

  // 10,000,000 paise = ₹100,000. A ceiling catches a fat-fingered price
  // before it becomes a receipt.
  @IsInt({ message: 'must be an integer number of paise' })
  @Min(0)
  @Max(10_000_000)
  priceMinor!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  taxRateBp?: number;

  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

export class CreateCategoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  @Transform(({ value }) => String(value).trim())
  name!: string;
}
