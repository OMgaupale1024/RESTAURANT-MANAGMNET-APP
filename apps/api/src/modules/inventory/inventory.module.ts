import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { PrepController } from './prep.controller';
import { PrepService } from './prep.service';

@Module({
  controllers: [InventoryController, PrepController],
  providers: [InventoryService, PrepService],
  // OrdersService depletes stock inside the order transaction.
  exports: [InventoryService],
})
export class InventoryModule {}
