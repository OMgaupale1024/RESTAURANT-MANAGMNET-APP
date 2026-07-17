import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import {
  CreateAdjustmentDto,
  CreateIngredientDto,
  CreateMovementDto,
  ListIngredientsQuery,
  SetRecipeDto,
} from './dto/inventory.dto';
import { InventoryService } from './inventory.service';

@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @RequirePermissions('inventory.read')
  @Get('ingredients')
  list(@Query() query: ListIngredientsQuery) {
    return this.inventory.list(query);
  }

  @RequirePermissions('inventory.read')
  @Get('ingredients/:id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.getById(id);
  }

  @RequirePermissions('inventory.manage')
  @Post('ingredients')
  create(@Body() dto: CreateIngredientDto) {
    return this.inventory.create(dto);
  }

  /** Receive stock or record waste. */
  @RequirePermissions('inventory.manage')
  @Post('ingredients/:id/movements')
  recordMovement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMovementDto,
  ) {
    return this.inventory.recordMovement(id, dto);
  }

  /** A stock count. Separate route because the quantity is signed here. */
  @RequirePermissions('inventory.manage')
  @Post('ingredients/:id/adjustments')
  recordAdjustment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAdjustmentDto,
  ) {
    return this.inventory.recordAdjustment(id, dto);
  }

  @RequirePermissions('inventory.read')
  @Get('products/:id/recipe')
  getRecipe(@Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.getRecipe(id);
  }

  // PUT, not PATCH: the recipe is replaced wholesale, so removing an
  // ingredient is possible.
  @RequirePermissions('inventory.manage')
  @Put('products/:id/recipe')
  setRecipe(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetRecipeDto) {
    return this.inventory.setRecipe(id, dto);
  }
}
