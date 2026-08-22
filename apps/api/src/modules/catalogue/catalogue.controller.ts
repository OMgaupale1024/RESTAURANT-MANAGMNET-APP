import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import { CatalogueService } from './catalogue.service';
import {
  CreateCategoryDto,
  CreateModifierGroupDto,
  CreateModifierOptionDto,
  CreateProductDto,
  ListProductsQuery,
  ReorderCategoriesDto,
  UpdateCategoryDto,
  UpdateModifierGroupDto,
  UpdateModifierOptionDto,
  UpdateProductDto,
} from './dto/product.dto';

@Controller()
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  // Cashiers and kitchen may read the menu; only owners/managers change it.
  @RequirePermissions('product.read')
  @Get('products')
  listProducts(@Query() query: ListProductsQuery) {
    return this.catalogue.listProducts(query.include === 'all');
  }

  @RequirePermissions('product.manage')
  @Post('products')
  createProduct(@Body() dto: CreateProductDto) {
    return this.catalogue.createProduct(dto);
  }

  @RequirePermissions('product.manage')
  @Patch('products/:id')
  updateProduct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.catalogue.updateProduct(id, dto);
  }

  // --- product modifiers. Cashiers get active modifiers embedded in the
  // product list (product.read); this management view returns all incl.
  // inactive. Every write is product.manage — a cashier can select modifiers
  // during a sale but can never change a definition or its price.
  @RequirePermissions('product.read')
  @Get('products/:productId/modifier-groups')
  listModifierGroups(@Param('productId', ParseUUIDPipe) productId: string) {
    return this.catalogue.listProductModifierGroups(productId);
  }

  @RequirePermissions('product.manage')
  @Post('products/:productId/modifier-groups')
  createModifierGroup(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: CreateModifierGroupDto,
  ) {
    return this.catalogue.createModifierGroup(productId, dto);
  }

  @RequirePermissions('product.manage')
  @Patch('modifier-groups/:id')
  updateModifierGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateModifierGroupDto,
  ) {
    return this.catalogue.updateModifierGroup(id, dto);
  }

  @RequirePermissions('product.manage')
  @Delete('modifier-groups/:id')
  deleteModifierGroup(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalogue.deleteModifierGroup(id);
  }

  @RequirePermissions('product.manage')
  @Post('modifier-groups/:groupId/options')
  createModifierOption(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() dto: CreateModifierOptionDto,
  ) {
    return this.catalogue.createModifierOption(groupId, dto);
  }

  @RequirePermissions('product.manage')
  @Patch('modifier-options/:id')
  updateModifierOption(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateModifierOptionDto,
  ) {
    return this.catalogue.updateModifierOption(id, dto);
  }

  @RequirePermissions('product.manage')
  @Delete('modifier-options/:id')
  deleteModifierOption(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalogue.deleteModifierOption(id);
  }

  @RequirePermissions('product.read')
  @Get('categories')
  listCategories() {
    return this.catalogue.listCategories();
  }

  @RequirePermissions('product.manage')
  @Post('categories')
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.catalogue.createCategory(dto);
  }

  // Declared before categories/:id so the router never reads "order" as an id.
  @RequirePermissions('product.manage')
  @Put('categories/order')
  reorderCategories(@Body() dto: ReorderCategoriesDto) {
    return this.catalogue.reorderCategories(dto);
  }

  @RequirePermissions('product.manage')
  @Patch('categories/:id')
  updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.catalogue.updateCategory(id, dto);
  }

  @RequirePermissions('product.manage')
  @Delete('categories/:id')
  deleteCategory(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalogue.deleteCategory(id);
  }
}
