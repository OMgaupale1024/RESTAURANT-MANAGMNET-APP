import { Module } from '@nestjs/common';
import { EventsModule } from '../../events/events.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { PrepController } from './prep.controller';
import { PrepService } from './prep.service';
import { StockCountController } from './stock-count.controller';
import { StockCountService } from './stock-count.service';

@Module({
  // EventsModule: a completed count records a stockcount.* audit event.
  imports: [EventsModule],
  controllers: [InventoryController, PrepController, StockCountController],
  providers: [InventoryService, PrepService, StockCountService],
  // OrdersService depletes stock inside the order transaction.
  exports: [InventoryService],
})
export class InventoryModule {}
