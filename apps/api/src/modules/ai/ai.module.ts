import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

@Module({
  // Reuses InventoryService for stock levels — the ledger/reorder rules live
  // there and are not duplicated here.
  imports: [InventoryModule],
  controllers: [AiController],
  providers: [AiService],
})
export class AiModule {}
