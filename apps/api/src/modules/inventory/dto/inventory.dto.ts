import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
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
import { StockUnit } from '../../../generated/prisma/enums';

/** Quantities are integers in the ingredient's base unit — grams, not kg. */
const MAX_QTY = 100_000_000; // 100 tonnes in grams. A ceiling catches a typo.

export class CreateIngredientDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  name!: string;

  @IsEnum(StockUnit)
  unit!: StockUnit;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_QTY)
  reorderLevel?: number;
}

/**
 * Movements the user may record directly.
 *
 * CONSUMPTION is deliberately absent: it is written by the server when an order
 * is placed, never by a client. Letting a client post CONSUMPTION would let a
 * cashier make stock disappear without a sale — the inventory equivalent of
 * voiding an order to cover theft.
 */
export enum ManualMovementType {
  PURCHASE = 'PURCHASE',
  WASTE = 'WASTE',
  ADJUSTMENT = 'ADJUSTMENT',
}

export class CreateMovementDto {
  @IsEnum(ManualMovementType)
  type!: ManualMovementType;

  /**
   * Magnitude, always positive. The server applies the sign from `type`, so a
   * client cannot post a "WASTE" that secretly adds stock.
   */
  @IsInt()
  @Min(1)
  @Max(MAX_QTY)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

/** ADJUSTMENT is signed — a stock count can go either way. */
export class CreateAdjustmentDto {
  @IsInt()
  @Min(-MAX_QTY)
  @Max(MAX_QTY)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class RecipeItemDto {
  @IsUUID()
  ingredientId!: string;

  /** Per ONE unit sold. */
  @IsInt()
  @Min(1)
  @Max(MAX_QTY)
  quantity!: number;
}

export class SetRecipeDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecipeItemDto)
  items!: RecipeItemDto[];
}

export class ListIngredientsQuery {
  /** Only ingredients at or below their reorder level. */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  lowStock?: boolean;
}
