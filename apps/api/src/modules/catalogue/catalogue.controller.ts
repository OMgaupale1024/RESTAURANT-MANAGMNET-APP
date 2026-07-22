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
  CreateProductDto,
  ListProductsQuery,
  ReorderCategoriesDto,
  UpdateCategoryDto,
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
