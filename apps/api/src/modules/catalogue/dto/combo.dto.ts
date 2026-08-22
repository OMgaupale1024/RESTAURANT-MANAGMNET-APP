import { Type } from 'class-transformer';
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
  ValidateNested,
} from 'class-validator';
import { Transform } from 'class-transformer';

/** One component of a combo — a reference to an existing product, never a copy. */
export class ComboItemInput {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class CreateComboDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  // The combo's own price in paise (owner-set, not derived). Same ceiling as a
  // product to catch a fat-fingered value.
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

  @IsOptional()
  @IsBoolean()
  isPopular?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsArray()
  @ArrayMinSize(1, { message: 'a combo needs at least one component' })
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ComboItemInput)
  items!: ComboItemInput[];
}

/** Every field optional. If `items` is present it REPLACES the component set. */
export class UpdateComboDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

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

  @IsOptional()
  @IsBoolean()
  isPopular?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'a combo needs at least one component' })
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ComboItemInput)
  items?: ComboItemInput[];
}

export class CreateUpsellRuleDto {
  @IsUUID()
  triggerProductId!: string;

  @IsUUID()
  suggestedProductId!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateUpsellRuleDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListCombosQuery {
  @IsOptional()
  @IsString()
  include?: string;
}
