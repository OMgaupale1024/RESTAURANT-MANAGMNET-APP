import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateCategoryDto, CreateProductDto } from './dto/product.dto';

@Injectable()
export class CatalogueService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every call goes through tx(), which reads the tenant from AsyncLocalStorage
   * and sets app.restaurant_id. There is no `where: { restaurantId }` here
   * because RLS applies it — and RLS cannot be forgotten.
   */
  listProducts() {
    return this.prisma.tx((db) =>
      db.product.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          priceMinor: true,
          taxRateBp: true,
          categoryId: true,
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  listCategories() {
    return this.prisma.tx((db) =>
      db.category.findMany({
        select: { id: true, name: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  async createProduct(dto: CreateProductDto) {
    const ctx = this.prisma.requireContext();
    try {
      return await this.prisma.tx((db) =>
        db.product.create({
          data: {
            restaurantId: ctx.restaurantId,
            name: dto.name,
            priceMinor: dto.priceMinor,
            ...(dto.taxRateBp !== undefined
              ? { taxRateBp: dto.taxRateBp }
              : {}),
            ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
          },
          select: {
            id: true,
            name: true,
            priceMinor: true,
            taxRateBp: true,
            categoryId: true,
          },
        }),
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('A product with that name already exists');
      }
      throw e;
    }
  }

  async createCategory(dto: CreateCategoryDto) {
    const ctx = this.prisma.requireContext();
    try {
      return await this.prisma.tx((db) =>
        db.category.create({
          data: { restaurantId: ctx.restaurantId, name: dto.name },
          select: { id: true, name: true },
        }),
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('A category with that name already exists');
      }
      throw e;
    }
  }
}

/** See restaurants.service.ts — Prisma 7 driver adapters moved this. */
function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002';
}
