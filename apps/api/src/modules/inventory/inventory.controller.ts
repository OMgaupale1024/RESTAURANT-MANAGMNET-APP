import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import {
  CreateAdjustmentDto,
  CreateIngredientDto,
  CreateMovementDto,
  CreateSupplierDto,
  ListIngredientsQuery,
  SetRecipeDto,
  UpdateIngredientDto,
  UpdateSupplierDto,
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

  @RequirePermissions('inventory.manage')
  @Patch('ingredients/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateIngredientDto,
  ) {
    return this.inventory.update(id, dto);
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

  // -- suppliers --

  @RequirePermissions('inventory.read')
  @Get('suppliers')
  listSuppliers(@Query() query: ListIngredientsQuery) {
    return this.inventory.listSuppliers(query.include === 'all');
  }

  @RequirePermissions('inventory.manage')
  @Post('suppliers')
  createSupplier(@Body() dto: CreateSupplierDto) {
    return this.inventory.createSupplier(dto);
  }

  @RequirePermissions('inventory.manage')
  @Patch('suppliers/:id')
  updateSupplier(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    return this.inventory.updateSupplier(id, dto);
  }

  // Food-cost analysis. Same gate as the books — margin is owner/manager info,
  // not a cashier's. (inventory.read covers owner/manager/kitchen; that is
  // acceptable — the kitchen seeing food cost is fine.)
  @RequirePermissions('inventory.read')
  @Get('products/costing')
  productCosting() {
    return this.inventory.productCosting();
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
