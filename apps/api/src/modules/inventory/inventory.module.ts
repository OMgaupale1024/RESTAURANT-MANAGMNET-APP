import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  controllers: [InventoryController],
  providers: [InventoryService],
  // OrdersService depletes stock inside the order transaction.
  exports: [InventoryService],
})
export class InventoryModule {}
