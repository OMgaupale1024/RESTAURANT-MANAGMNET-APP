import { Module } from '@nestjs/common';
import { EventsModule } from '../../events/events.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ProcurementController } from './procurement.controller';
import { ProcurementService } from './procurement.service';

/**
 * Procurement — suppliers, purchase orders and reorder intelligence. Reuses
 * InventoryService (the stock ledger and the low-stock list) and EventsService
 * (the Timeline seam); it stores no purchase history of its own — a received PO
 * writes ordinary PURCHASE stock movements.
 */
@Module({
  imports: [EventsModule, InventoryModule],
  controllers: [ProcurementController],
  providers: [ProcurementService],
})
export class ProcurementModule {}
