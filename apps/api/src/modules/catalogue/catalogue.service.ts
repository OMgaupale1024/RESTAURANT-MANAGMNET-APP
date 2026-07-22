import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService, type TxClient } from '../../prisma/prisma.service';
import type {
  CreateCategoryDto,
  CreateProductDto,
  ReorderCategoriesDto,
  UpdateCategoryDto,
  UpdateProductDto,
} from './dto/product.dto';

const PRODUCT_SELECT = {
  id: true,
  name: true,
  priceMinor: true,
  taxRateBp: true,
  categoryId: true,
  isActive: true,
} as const;

@Injectable()
export class CatalogueService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every call goes through tx(), which reads the tenant from AsyncLocalStorage
   * and sets app.restaurant_id. There is no `where: { restaurantId }` here
   * because RLS applies it — and RLS cannot be forgotten.
   */
  listProducts(includeInactive = false) {
    return this.prisma.tx((db) =>
      db.product.findMany({
        where: includeInactive ? undefined : { isActive: true },
        select: PRODUCT_SELECT,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  listCategories() {
    return this.prisma.tx((db) =>
      db.category.findMany({
        select: { id: true, name: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  async createProduct(dto: CreateProductDto) {
    const ctx = this.prisma.requireContext();
    try {
      return await this.prisma.tx(async (db) => {
        if (dto.categoryId) await this.assertCategory(db, dto.categoryId);
        return db.product.create({
          data: {
            restaurantId: ctx.restaurantId,
            name: dto.name,
            priceMinor: dto.priceMinor,
            ...(dto.taxRateBp !== undefined
              ? { taxRateBp: dto.taxRateBp }
              : {}),
            ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
          },
          select: PRODUCT_SELECT,
        });
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('A product with that name already exists');
      }
      throw e;
    }
  }

  /**
   * Edits a product in place. Live orders are unaffected by design:
   * order_items snapshot name/price/tax at sale time, so a menu edit can never
   * rewrite a receipt. isActive:false is the only "delete" — see the DTO.
   */
  async updateProduct(id: string, dto: UpdateProductDto) {
    return this.prisma.tx(async (db) => {
      const existing = await db.product.findFirst({
        where: { id },
        select: { id: true },
      });
      // Another tenant's product does not exist here (RLS) — same 404 as a
      // bad id, so this cannot probe which ids are real.
      if (!existing) throw new NotFoundException('Product not found');

      // A categoryId is a request, not a claim: verify it belongs to this
      // tenant before pointing at it. (FK checks ignore RLS, so without this
      // a product could reference another restaurant's category.)
      if (dto.categoryId) await this.assertCategory(db, dto.categoryId);

      try {
        return await db.product.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.priceMinor !== undefined
              ? { priceMinor: dto.priceMinor }
              : {}),
            ...(dto.taxRateBp !== undefined
              ? { taxRateBp: dto.taxRateBp }
              : {}),
            // null clears the category; undefined leaves it alone.
            ...(dto.categoryId !== undefined
              ? { categoryId: dto.categoryId }
              : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
          select: PRODUCT_SELECT,
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new ConflictException(
            'A product with that name already exists',
          );
        }
        throw e;
      }
    });
  }

  async createCategory(dto: CreateCategoryDto) {
    const ctx = this.prisma.requireContext();
    try {
      return await this.prisma.tx((db) =>
        db.category.create({
          data: { restaurantId: ctx.restaurantId, name: dto.name },
          select: { id: true, name: true, sortOrder: true },
        }),
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('A category with that name already exists');
      }
      throw e;
    }
  }

  async updateCategory(id: string, dto: UpdateCategoryDto) {
    return this.prisma.tx(async (db) => {
      const existing = await db.category.findFirst({
        where: { id },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Category not found');
      try {
        return await db.category.update({
          where: { id },
          data: { ...(dto.name !== undefined ? { name: dto.name } : {}) },
          select: { id: true, name: true, sortOrder: true },
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new ConflictException(
            'A category with that name already exists',
          );
        }
        throw e;
      }
    });
  }

  /**
   * Deleting a category never deletes its products: the FK is onDelete:
   * SetNull, so they become "uncategorised" and stay on the menu. That is what
   * makes this delete safe enough to expose.
   */
  async deleteCategory(id: string) {
    return this.prisma.tx(async (db) => {
      const existing = await db.category.findFirst({
        where: { id },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Category not found');
      await db.category.delete({ where: { id } });
      return { deleted: true };
    });
  }

  /**
   * Rewrites the display order in one transaction: sortOrder = index in ids.
   * The array must name every category exactly once — a partial list would
   * silently interleave with stale sortOrders and produce an order nobody chose.
   */
  async reorderCategories(dto: ReorderCategoriesDto) {
    const unique = new Set(dto.ids);
    if (unique.size !== dto.ids.length) {
      throw new BadRequestException('Duplicate category ids');
    }
    return this.prisma.tx(async (db) => {
      const count = await db.category.count();
      if (count !== dto.ids.length) {
        throw new BadRequestException(
          'The order must include every category exactly once',
        );
      }
      // RLS scopes each update; an id from another tenant matches zero rows.
      // Serial, not Promise.all: concurrent queries share this transaction's one
      // pg connection — unsafe under @prisma/adapter-pg (removed in pg v9).
      const results: Array<{ count: number }> = [];
      for (const [index, id] of dto.ids.entries()) {
        results.push(
          await db.category.updateMany({
            where: { id },
            data: { sortOrder: index },
          }),
        );
      }
      if (results.some((r) => r.count === 0)) {
        throw new BadRequestException('Unknown category in order');
      }
      return this.listCategoriesIn(db);
    });
  }

  private listCategoriesIn(db: TxClient) {
    return db.category.findMany({
      select: { id: true, name: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  /** 400 when the category does not exist in this tenant. */
  private async assertCategory(db: TxClient, categoryId: string) {
    const cat = await db.category.findFirst({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!cat) throw new BadRequestException('Unknown category');
  }
}

/** See restaurants.service.ts — Prisma 7 driver adapters moved this. */
function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002';
}
