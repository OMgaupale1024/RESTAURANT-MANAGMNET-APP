import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import { AuditLogQuery } from './dto/audit-log.query';
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

  @RequirePermissions('analytics.read')
  @Get('gst')
  gst(@Query() query: SalesReportQuery) {
    return this.reports.gst(query.from, query.to);
  }

  @RequirePermissions('analytics.read')
  @Get('items')
  items(@Query() query: SalesReportQuery) {
    return this.reports.itemSales(query.from, query.to);
  }

  @RequirePermissions('analytics.read')
  @Get('categories')
  categories(@Query() query: SalesReportQuery) {
    return this.reports.categorySales(query.from, query.to);
  }

  @RequirePermissions('analytics.read')
  @Get('settlement')
  settlement(@Query() query: SalesReportQuery) {
    return this.reports.settlement(query.from, query.to);
  }

  @RequirePermissions('analytics.read')
  @Get('voids')
  voids(@Query() query: SalesReportQuery) {
    return this.reports.voids(query.from, query.to);
  }

  @RequirePermissions('analytics.read')
  @Get('discounts')
  discounts(@Query() query: SalesReportQuery) {
    return this.reports.discounts(query.from, query.to);
  }

  // The audit log has its own permission — it is the anti-theft record, seeded
  // only to OWNER and MANAGER.
  @RequirePermissions('audit.read')
  @Get('audit')
  audit(@Query() query: AuditLogQuery) {
    return this.reports.auditLog(query);
  }
}
