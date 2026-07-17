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
import { PaymentMethod } from '../../../generated/prisma/enums';

/**
 * Note what a line item does NOT accept: a price.
 *
 * The client sends what was ordered, never what it costs. Prices are read from
 * the database at sale time. Accepting a client price would let anyone buy
 * anything for zero — the single most obvious attack on a POS API, and a
 * depressingly common one.
 */
export class OrderItemDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(999)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string;
}

export class CreateOrderDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'an order needs at least one item' })
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  /**
   * Optional: most orders are anonymous walk-ins.
   *
   * A client-supplied id is safe here for the same reason as
   * select-restaurant: the server verifies it belongs to this tenant before
   * using it. It is a request, not a claim.
   */
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  /**
   * Supplied by the client so a retry cannot double-charge. Required for the
   * offline queue later; useful immediately against a double-tapped Pay button
   * on a laggy tablet.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string;
}
