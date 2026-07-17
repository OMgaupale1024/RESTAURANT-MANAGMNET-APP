import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { InventoryModule } from '../inventory/inventory.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MarketingModule } from '../marketing/marketing.module';

@Module({
  imports: [InventoryModule, RealtimeModule, MarketingModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
