import { Module } from '@nestjs/common';
import { MarketingController } from './marketing.controller';
import { MarketingService } from './marketing.service';

@Module({
  controllers: [MarketingController],
  providers: [MarketingService],
  // OrdersService uses it to validate + redeem a coupon inside the order tx.
  exports: [MarketingService],
})
export class MarketingModule {}
