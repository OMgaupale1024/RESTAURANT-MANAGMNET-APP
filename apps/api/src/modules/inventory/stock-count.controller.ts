import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import { StartStockCountDto, SubmitStockCountDto } from './dto/stock-count.dto';
import { StockCountService } from './stock-count.service';

/**
 * Physical stock counts. Reuses the inventory gates: inventory.read to view
 * counts, inventory.manage to start, submit and cancel them — the SAME
 * permission that already governs the single-ingredient adjustment
 * (POST /ingredients/:id/adjustments), held by owner, manager and kitchen, never
 * a cashier. Backend authorization, never hidden UI.
 */
@Controller()
export class StockCountController {
  constructor(private readonly stockCounts: StockCountService) {}

  @RequirePermissions('inventory.read')
  @Get('stock-counts')
  list() {
    return this.stockCounts.list();
  }

  @RequirePermissions('inventory.read')
  @Get('stock-counts/:id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.stockCounts.getById(id);
  }

  @RequirePermissions('inventory.manage')
  @Post('stock-counts')
  start(@Body() dto: StartStockCountDto) {
    return this.stockCounts.start(dto);
  }

  @RequirePermissions('inventory.manage')
  @Post('stock-counts/:id/submit')
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitStockCountDto,
  ) {
    return this.stockCounts.submit(id, dto);
  }

  @RequirePermissions('inventory.manage')
  @Post('stock-counts/:id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.stockCounts.cancel(id);
  }
}
