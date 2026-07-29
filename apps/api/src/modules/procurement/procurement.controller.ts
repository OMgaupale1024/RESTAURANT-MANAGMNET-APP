import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import {
  CreatePurchaseOrderDto,
  ListPurchaseOrdersQuery,
  TransitionPurchaseOrderDto,
} from './dto/procurement.dto';
import { ProcurementService } from './procurement.service';

@Controller()
export class ProcurementController {
  constructor(private readonly procurement: ProcurementService) {}

  // Reading procurement uses the same gate as reading stock. Recording a PO or
  // moving it along (which, on receipt, writes stock) needs inventory.manage.

  @RequirePermissions('inventory.read')
  @Get('suppliers/insights')
  supplierInsights() {
    return this.procurement.supplierInsights();
  }

  @RequirePermissions('inventory.read')
  @Get('inventory/reorder-suggestions')
  reorderSuggestions() {
    return this.procurement.reorderSuggestions();
  }

  @RequirePermissions('inventory.read')
  @Get('purchase-orders')
  list(@Query() query: ListPurchaseOrdersQuery) {
    return this.procurement.listPurchaseOrders(query.status);
  }

  @RequirePermissions('inventory.read')
  @Get('purchase-orders/:id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.procurement.getPurchaseOrder(id);
  }

  @RequirePermissions('inventory.manage')
  @Post('purchase-orders')
  create(@Body() dto: CreatePurchaseOrderDto) {
    return this.procurement.createPurchaseOrder(dto);
  }

  @RequirePermissions('inventory.manage')
  @Patch('purchase-orders/:id/status')
  transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionPurchaseOrderDto,
  ) {
    return this.procurement.transition(id, dto);
  }
}
