import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Quantities are integers in the ingredient's base unit — grams, not kg. */
const MAX_QTY = 100_000_000;

export class PurchaseOrderItemDto {
  @IsUUID()
  ingredientId!: string;

  /** Ordered quantity, base unit. */
  @IsInt()
  @Min(1)
  @Max(MAX_QTY)
  quantity!: number;

  /** Agreed TOTAL cost for this line (paise). Optional — price may be unknown. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  totalCostMinor?: number;
}

export class CreatePurchaseOrderDto {
  @IsUUID()
  supplierId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  items!: PurchaseOrderItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/**
 * A status move. DRAFT → ORDERED → RECEIVED, or CANCELLED from DRAFT/ORDERED —
 * the service owns the whitelist; a client can only name a target. Receiving
 * writes the PURCHASE stock movements.
 */
export class TransitionPurchaseOrderDto {
  @IsIn(['ORDERED', 'RECEIVED', 'CANCELLED'])
  status!: 'ORDERED' | 'RECEIVED' | 'CANCELLED';
}

export class ListPurchaseOrdersQuery {
  @IsOptional()
  @IsIn(['DRAFT', 'ORDERED', 'RECEIVED', 'CANCELLED'])
  status?: 'DRAFT' | 'ORDERED' | 'RECEIVED' | 'CANCELLED';
}
