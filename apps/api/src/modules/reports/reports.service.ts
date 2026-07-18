import { BadRequestException, Injectable } from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service';

/** IST is UTC+5:30. A "day" for an India-first business is an IST wall day. */
const IST_OFFSET = '+05:30';

@Injectable()
export class ReportsService {
  constructor(private readonly analytics: AnalyticsService) {}

  /**
   * Sales for an explicit IST day window, inclusive of both ends.
   *
   * The figures are NOT recomputed here — this delegates to
   * AnalyticsService.overviewBetween, so a report total is by construction the
   * same number the dashboard shows for the same window. Reports adds only the
   * custom range; the aggregation stays in one place.
   */
  async sales(fromStr: string, toStr: string) {
    // Anchor each calendar day to its IST boundary: from at 00:00, to at end of
    // day, so both endpoints are whole IST days.
    const from = new Date(`${fromStr}T00:00:00.000${IST_OFFSET}`);
    const to = new Date(`${toStr}T23:59:59.999${IST_OFFSET}`);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from and to must be real calendar dates');
    }
    if (from > to) {
      throw new BadRequestException('from must not be after to');
    }

    return this.analytics.overviewBetween(from, to);
  }
}
