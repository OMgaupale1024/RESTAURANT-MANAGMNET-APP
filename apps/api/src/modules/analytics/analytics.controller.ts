import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import { AnalyticsQuery } from './dto/analytics.query';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  // Read-only, owner/manager only. A cashier does not see the books.
  @RequirePermissions('analytics.read')
  @Get('overview')
  overview(@Query() query: AnalyticsQuery) {
    return this.analytics.overview(query.range ?? '7d');
  }
}
