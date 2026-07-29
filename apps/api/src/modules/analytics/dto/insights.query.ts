import { IsIn, IsOptional, Matches } from 'class-validator';

/**
 * The owner-insights window. Same preset model as the sales overview, plus an
 * explicit from/to for the Yesterday and Custom cases the client resolves to
 * dates (exactly as the sales side already does through Reports). Presets are
 * server-resolved to IST bounds; from/to are inclusive IST days, shape-checked
 * here and NaN-checked in the service.
 */
export class InsightsQuery {
  @IsOptional()
  @IsIn(['today', '7d', '30d', '90d'])
  range?: 'today' | '7d' | '30d' | '90d';

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;
}
