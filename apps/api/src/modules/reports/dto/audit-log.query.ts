import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * The Timeline's activity categories. Each maps to an action prefix
 * server-side (see ReportsService.auditLog) — the client sends the label, the
 * service owns the mapping, so the two never drift. Kept deliberately to the
 * categories that actually exist in `audit_logs`: kitchen, inventory, cash and
 * auth live in their own ledgers by design (docs/architecture/timeline.md).
 */
export const AUDIT_CATEGORIES = [
  'orders',
  'refunds',
  'customers',
  'loyalty',
  'staff',
  'settings',
] as const;

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

  /** Activity category — mapped to an action prefix server-side. */
  @IsOptional()
  @IsIn(AUDIT_CATEGORIES)
  category?: (typeof AUDIT_CATEGORIES)[number];

  /** Inclusive IST day bounds (YYYY-MM-DD). Shape only; realness is checked
   *  in the service, the same NaN guard the sales window uses. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  /** Free-text search over the action and entity type. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  q?: string;
}
