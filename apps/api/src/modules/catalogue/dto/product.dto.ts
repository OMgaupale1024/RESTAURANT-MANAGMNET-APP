import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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

/**
 * Every field optional; only the ones present are written. categoryId accepts
 * an explicit null to move a product back to "uncategorised" — IsOptional
 * skips validation for null as well as undefined, and the service treats the
 * two differently (null clears, undefined leaves alone).
 */
export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  name?: string;

  @IsOptional()
  @IsInt({ message: 'must be an integer number of paise' })
  @Min(0)
  @Max(10_000_000)
  priceMinor?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  taxRateBp?: number;

  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  /**
   * Deactivate / reactivate. Deactivation is the ONLY removal there is:
   * order_items reference products by id with no FK, so a hard delete would
   * orphan every receipt that ever sold the item.
   */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  @Transform(({ value }) => String(value).trim())
  name?: string;
}

/**
 * The full display order in one call: sortOrder = index in this array.
 * One atomic write beats N racing PATCHes from up/down buttons.
 */
export class ReorderCategoriesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  ids!: string[];
}

export class ListProductsQuery {
  /**
   * "all" includes deactivated products — the Menu screen needs them to offer
   * reactivation. POS omits it and sells only what is active.
   */
  @IsOptional()
  @IsString()
  include?: string;
}
