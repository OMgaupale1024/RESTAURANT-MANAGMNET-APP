import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
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
import { IsEnum } from 'class-validator';

/** Integers in the item's base unit — grams, not kg. Same ceiling as inventory. */
const MAX_QTY = 100_000_000;
/** One year, in hours — a sane ceiling for a shelf life. */
const MAX_SHELF_HOURS = 24 * 365;

/** A prepared ingredient — made in the kitchen, not purchased. */
export class CreatePrepItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  name!: string;

  @IsEnum(StockUnit)
  unit!: StockUnit;

  /** Default expiry: a new batch expires this many hours after it is prepared. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SHELF_HOURS)
  shelfLifeHours?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_QTY)
  reorderLevel?: number;
}

export class UpdatePrepItemDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => String(value).trim())
  name?: string;

  /** null clears the default shelf life (batches then have no auto-expiry). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SHELF_HOURS)
  shelfLifeHours?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_QTY)
  reorderLevel?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** One raw component of a prep recipe. */
export class PrepComponentDto {
  @IsUUID()
  ingredientId!: string;

  /** Per one standard batch (batchYield), in the component's base unit. */
  @IsInt()
  @Min(1)
  @Max(MAX_QTY)
  quantity!: number;
}

/**
 * A prep recipe is its components AND the yield they produce — the two are
 * coupled ("these inputs make this much"), so they are set together. Replaces
 * the recipe wholesale, like a product recipe.
 */
export class SetPrepRecipeDto {
  /** What one standard batch of these components yields, in the item's unit. */
  @IsInt()
  @Min(1)
  @Max(MAX_QTY)
  batchYield!: number;

  @IsArray()
  @ArrayMinSize(1, { message: 'a prep recipe needs at least one component' })
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PrepComponentDto)
  items!: PrepComponentDto[];
}

/**
 * Prepare a batch. `quantity` is the planned/expected yield — the recipe scales
 * its raw consumption to it. `actualQuantity` is what was really produced (the
 * amount stocked); it defaults to the planned amount and only differs when a
 * batch over/under-yields. The server prices and consumes; the client sends no
 * cost and no raw quantities.
 */
export class CreateBatchDto {
  @IsInt()
  @Min(1)
  @Max(MAX_QTY)
  quantity!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_QTY)
  actualQuantity?: number;

  /** ISO date-time. Overrides the item's default shelf life for this batch. */
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  /** Double-tap / retry guard — a replayed prepare must not consume raw twice. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string;
}

/** Waste a quantity of a prepared batch (spoiled, expired, spilled…). */
export class WasteBatchDto {
  @IsInt()
  @Min(1)
  @Max(MAX_QTY)
  quantity!: number;

  /** e.g. "Expired", "Spoiled", "Spillage" — free text, kept on the ledger row. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string;
}
