import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
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

  /**
   * PURCHASE only: the supplier and the TOTAL cost of this receipt (paise).
   * Total, not per-unit — see the schema. The server ignores both unless the
   * movement is a PURCHASE.
   */
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  totalCostMinor?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  /**
   * Supplied by the client so a double-click, retry, or refresh cannot apply
   * the same movement twice. Same contract as an order's key — see
   * InventoryService.recordMovement.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string;
}

export class CreateSupplierDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export class UpdateSupplierDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
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

  /** Idempotency key — a retried stock count must not append twice. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string;
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

  /** "all" includes deactivated ingredients, for the management view. */
  @IsOptional()
  @IsString()
  include?: string;
}

/**
 * Every field optional; only the ones present are written.
 *
 * unit is changeable ONLY while the ingredient has no recorded movements and
 * no recipes — the ledger and every recipe quantity are denominated in the
 * current unit, and re-labelling 500 grams as 500 millilitres would silently
 * falsify both. The service enforces this; see update().
 *
 * reorderLevel accepts null to stop tracking (distinct from 0, which means
 * "flag when empty").
 */
export class UpdateIngredientDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  name?: string;

  @IsOptional()
  @IsEnum(StockUnit)
  unit?: StockUnit;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_QTY)
  reorderLevel?: number | null;

  /** Deactivation hides it from the operational list; history stays. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
