import { Matches } from 'class-validator';

/**
 * A custom sales-report window. Unlike Analytics (fixed presets), Reports lets
 * the owner pick explicit calendar days — the from/to date picker deferred from
 * Step 16 (BACKLOG #31).
 *
 * Dates are plain calendar days (YYYY-MM-DD), not instants: the report is about
 * IST business days, and the service turns each into an IST day boundary. A
 * regex keeps it to a date with no time, so a client cannot smuggle a timezone.
 */
export class SalesReportQuery {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to!: string;
}
