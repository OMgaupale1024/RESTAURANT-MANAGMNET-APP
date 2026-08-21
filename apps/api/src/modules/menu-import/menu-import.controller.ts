import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import { ExtractMenuDto, MenuResultDto } from './dto/menu-import.dto';
import { MenuImportService } from './menu-import.service';

/**
 * The AI menu scanner. Every route is product.manage — the same gate the rest
 * of the catalogue uses, so OWNER and MANAGER may scan and import, and CASHIER
 * and KITCHEN cannot (spec §17). Tenant isolation is RLS, as everywhere.
 */
@Controller('menu-import')
export class MenuImportController {
  constructor(private readonly svc: MenuImportService) {}

  // Extraction hits a paid vision API and is heavy; throttle it harder than the
  // global 100/min so a double-tapped Scan cannot fan out into many calls.
  @RequirePermissions('product.manage')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('extract')
  extract(@Body() dto: ExtractMenuDto) {
    return this.svc.extract(dto.images);
  }

  @RequirePermissions('product.manage')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(id);
  }

  @RequirePermissions('product.manage')
  @Patch(':id')
  saveDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MenuResultDto,
  ) {
    return this.svc.saveDraft(id, dto.result);
  }

  @RequirePermissions('product.manage')
  @Post(':id/import')
  import(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MenuResultDto) {
    return this.svc.import(id, dto.result);
  }

  @RequirePermissions('product.manage')
  @Post(':id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.cancel(id);
  }
}
