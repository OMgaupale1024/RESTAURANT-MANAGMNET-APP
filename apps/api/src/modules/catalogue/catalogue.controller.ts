import { Body, Controller, Get, Post } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import { CatalogueService } from './catalogue.service';
import { CreateCategoryDto, CreateProductDto } from './dto/product.dto';

@Controller()
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  // Cashiers and kitchen may read the menu; only owners/managers change it.
  @RequirePermissions('product.read')
  @Get('products')
  listProducts() {
    return this.catalogue.listProducts();
  }

  @RequirePermissions('product.manage')
  @Post('products')
  createProduct(@Body() dto: CreateProductDto) {
    return this.catalogue.createProduct(dto);
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
}
