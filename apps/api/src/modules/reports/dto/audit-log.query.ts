import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class AuditLogQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Keyset cursor: the id of the last row already shown. */
  @IsOptional()
  @IsUUID()
  cursor?: string;

  /** Exact action filter, e.g. "order.voided". */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  action?: string;
}
