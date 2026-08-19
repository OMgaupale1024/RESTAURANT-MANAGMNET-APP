import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { StockCountReason } from '../../../generated/prisma/enums';

/** Integers in the ingredient's base unit — grams, not kg. Same ceiling as inventory. */
const MAX_QTY = 100_000_000;

/**
 * Start a count. With no scope it snapshots every active ingredient (raw and
 * prepared) — the simplest workflow for a small kitchen (§9). `ingredientIds`
 * narrows it to a chosen set; `lowStockOnly` to the items already flagged low.
 * Filtering is never required.
 */
export class StartStockCountDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  @IsUUID('all', { each: true })
  ingredientIds?: string[];

  @IsOptional()
  lowStockOnly?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

/** One physical count a staff member entered. */
export class StockCountLineInputDto {
  @IsUUID()
  ingredientId!: string;

  /**
   * What was physically counted, in the ingredient's base unit. Non-negative —
   * a negative physical quantity is meaningless (§15); the server also has a DB
   * CHECK as a backstop.
   */
  @IsInt()
  @Min(0)
  @Max(MAX_QTY)
  countedQuantity!: number;

  /**
   * Why it differs from the system. Required for any non-zero discrepancy — the
   * server enforces that after reconciling against live stock, so a count that
   * matches needs no reason (§12).
   */
  @IsOptional()
  @IsEnum(StockCountReason)
  reason?: StockCountReason;
}

export class SubmitStockCountDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'a count needs at least one line' })
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => StockCountLineInputDto)
  lines!: StockCountLineInputDto[];

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}
