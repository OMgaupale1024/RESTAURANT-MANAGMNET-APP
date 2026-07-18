import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  // ReportsService (Step 19) reuses this to avoid recomputing sales figures.
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
