import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import {
  CreateBatchDto,
  CreatePrepItemDto,
  SetPrepRecipeDto,
  UpdatePrepItemDto,
  WasteBatchDto,
} from './dto/prep.dto';
import { PrepService } from './prep.service';

/**
 * Prepared inventory. Reuses the inventory gates: inventory.read to view the
 * prep board and detail, inventory.manage to configure recipes, prepare batches
 * and record waste — the same permissions that already govern stock and recipes,
 * held by owner, manager and kitchen (never a cashier). Backend authorization,
 * never hidden UI.
 */
@Controller()
export class PrepController {
  constructor(private readonly prep: PrepService) {}

  @RequirePermissions('inventory.read')
  @Get('prep/items')
  listItems() {
    return this.prep.listItems();
  }

  @RequirePermissions('inventory.read')
  @Get('prep/items/:id')
  getItem(@Param('id', ParseUUIDPipe) id: string) {
    return this.prep.getItem(id);
  }

  @RequirePermissions('inventory.manage')
  @Post('prep/items')
  createItem(@Body() dto: CreatePrepItemDto) {
    return this.prep.createItem(dto);
  }

  @RequirePermissions('inventory.manage')
  @Patch('prep/items/:id')
  updateItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePrepItemDto,
  ) {
    return this.prep.updateItem(id, dto);
  }

  // PUT: the recipe (yield + components) is replaced wholesale, so removing a
  // component is possible.
  @RequirePermissions('inventory.manage')
  @Put('prep/items/:id/recipe')
  setRecipe(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetPrepRecipeDto,
  ) {
    return this.prep.setRecipe(id, dto);
  }

  @RequirePermissions('inventory.manage')
  @Post('prep/items/:id/batches')
  createBatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateBatchDto,
  ) {
    return this.prep.createBatch(id, dto);
  }

  @RequirePermissions('inventory.manage')
  @Post('prep/batches/:id/waste')
  wasteBatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WasteBatchDto,
  ) {
    return this.prep.wasteBatch(id, dto);
  }
}
