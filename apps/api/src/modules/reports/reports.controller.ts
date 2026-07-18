import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import { SalesReportQuery } from './dto/sales-report.query';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  // Same gate as Analytics — the books are owner/manager only, not a cashier's.
  @RequirePermissions('analytics.read')
  @Get('sales')
  sales(@Query() query: SalesReportQuery) {
    return this.reports.sales(query.from, query.to);
  }
}
