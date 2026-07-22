import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { OrderStatus } from '../../../generated/prisma/enums';

export class ListOrdersQuery {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  // Capped so a client cannot ask for the whole table.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /**
   * Keyset cursor: the id of the last row already shown. UUIDv7 ids are
   * time-ordered, so "id < cursor" IS "older than the last row" — stable
   * under concurrent inserts, unlike OFFSET.
   */
  @IsOptional()
  @IsUUID()
  cursor?: string;
}
