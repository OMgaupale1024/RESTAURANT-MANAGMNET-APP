import { IsIn, IsOptional } from 'class-validator';

/**
 * A preset date range keeps the API honest: the client picks a window, the
 * server decides the exact bounds. Arbitrary from/to is deferred to Reports
 * (Step 19) where a real date picker belongs.
 */
export class AnalyticsQuery {
  @IsOptional()
  @IsIn(['today', '7d', '30d', '90d'])
  range?: 'today' | '7d' | '30d' | '90d';
}
