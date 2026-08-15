import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService, type TxClient } from '../../prisma/prisma.service';
import type {
  CreateComboDto,
  CreateUpsellRuleDto,
  UpdateComboDto,
  UpdateUpsellRuleDto,
} from './dto/combo.dto';

/** Components with each product's current name/price/active — the POS shape. */
const COMBO_ITEM_SELECT = {
  productId: true,
  quantity: true,
  sortOrder: true,
  product: { select: { name: true, priceMinor: true, isActive: true } },
} as const;

const COMBO_SELECT = {
  id: true,
  name: true,
  description: true,
  priceMinor: true,
  taxRateBp: true,
  categoryId: true,
  isActive: true,
  isPopular: true,
  sortOrder: true,
  items: { orderBy: { sortOrder: 'asc' }, select: COMBO_ITEM_SELECT },
} as const;

type ComboRow = {
  items: Array<{ product: { isActive: boolean } }>;
};

/** A combo is sellable only if every component is still active. */
function withAvailability<T extends ComboRow>(combo: T) {
  return { ...combo, available: combo.items.every((i) => i.product.isActive) };
}

@Injectable()
export class CombosService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Combos with their components and an `available` flag. RLS scopes to the
   * tenant. POS omits inactive; management (`includeInactive`) sees everything
   * so it can reactivate and fix combos whose component went unavailable.
   */
  listCombos(includeInactive = false) {
    return this.prisma.tx(async (db) => {
      const rows = await db.combo.findMany({
        where: includeInactive ? undefined : { isActive: true },
        select: COMBO_SELECT,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      return rows.map(withAvailability);
    });
  }

  async createCombo(dto: CreateComboDto) {
    const ctx = this.prisma.requireContext();
    try {
      return await this.prisma.tx(async (db) => {
        await this.assertProductsActive(
          db,
          dto.items.map((i) => i.productId),
        );
        if (dto.categoryId) await this.assertCategory(db, dto.categoryId);
        const combo = await db.combo.create({
          data: {
            restaurantId: ctx.restaurantId,
            name: dto.name,
            description: dto.description ?? null,
            priceMinor: dto.priceMinor,
            ...(dto.taxRateBp !== undefined ? { taxRateBp: dto.taxRateBp } : {}),
            ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
            ...(dto.isPopular !== undefined ? { isPopular: dto.isPopular } : {}),
            ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
            items: {
              create: dto.items.map((i, idx) => ({
                restaurantId: ctx.restaurantId,
                productId: i.productId,
                quantity: i.quantity,
                sortOrder: i.sortOrder ?? idx,
              })),
            },
          },
          select: COMBO_SELECT,
        });
        return withAvailability(combo);
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('A combo with that name already exists');
      }
      throw e;
    }
  }

  async updateCombo(id: string, dto: UpdateComboDto) {
    const ctx = this.prisma.requireContext();
    try {
      return await this.prisma.tx(async (db) => {
        const existing = await db.combo.findFirst({
          where: { id },
          select: { id: true },
        });
        if (!existing) throw new NotFoundException('Combo not found');
        if (dto.categoryId) await this.assertCategory(db, dto.categoryId);
        if (dto.items) {
          await this.assertProductsActive(
            db,
            dto.items.map((i) => i.productId),
          );
          // Replace the component set atomically.
          await db.comboItem.deleteMany({ where: { comboId: id } });
          await db.comboItem.createMany({
            data: dto.items.map((i, idx) => ({
              restaurantId: ctx.restaurantId,
              comboId: id,
              productId: i.productId,
              quantity: i.quantity,
              sortOrder: i.sortOrder ?? idx,
            })),
          });
        }
        const combo = await db.combo.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.description !== undefined
              ? { description: dto.description }
              : {}),
            ...(dto.priceMinor !== undefined
              ? { priceMinor: dto.priceMinor }
              : {}),
            ...(dto.taxRateBp !== undefined ? { taxRateBp: dto.taxRateBp } : {}),
            ...(dto.categoryId !== undefined
              ? { categoryId: dto.categoryId }
              : {}),
            ...(dto.isPopular !== undefined ? { isPopular: dto.isPopular } : {}),
            ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
          select: COMBO_SELECT,
        });
        return withAvailability(combo);
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('A combo with that name already exists');
      }
      throw e;
    }
  }

  /**
   * Hard delete is safe: an order line snapshots the combo name, price and
   * components (order_items.combo_items), so removing a combo never makes a
   * past order unreadable. Cascade removes the combo's components.
   */
  async deleteCombo(id: string) {
    return this.prisma.tx(async (db) => {
      const existing = await db.combo.findFirst({
        where: { id },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Combo not found');
      await db.combo.delete({ where: { id } });
      return { deleted: true };
    });
  }

  // --------------------------------------------------------------- upsells

  /** All rules with the suggested product resolved — for POS and management. */
  listUpsellRules() {
    return this.prisma.tx((db) =>
      db.upsellRule.findMany({
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          triggerProductId: true,
          suggestedProductId: true,
          sortOrder: true,
          isActive: true,
          triggerProduct: { select: { name: true } },
          suggestedProduct: {
            select: { name: true, priceMinor: true, isActive: true },
          },
        },
      }),
    );
  }

  async createUpsellRule(dto: CreateUpsellRuleDto) {
    const ctx = this.prisma.requireContext();
    if (dto.triggerProductId === dto.suggestedProductId) {
      throw new BadRequestException('A product cannot upsell itself');
    }
    try {
      return await this.prisma.tx(async (db) => {
        await this.assertProductsActive(db, [
          dto.triggerProductId,
          dto.suggestedProductId,
        ]);
        // Reject the direct reciprocal (A→B when B→A is active) so the counter
        // never bounces between two suggestions.
        const reciprocal = await db.upsellRule.findFirst({
          where: {
            triggerProductId: dto.suggestedProductId,
            suggestedProductId: dto.triggerProductId,
            isActive: true,
          },
          select: { id: true },
        });
        if (reciprocal) {
          throw new BadRequestException(
            'The reverse suggestion already exists — that would loop',
          );
        }
        return db.upsellRule.create({
          data: {
            restaurantId: ctx.restaurantId,
            triggerProductId: dto.triggerProductId,
            suggestedProductId: dto.suggestedProductId,
            ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          },
          select: { id: true, triggerProductId: true, suggestedProductId: true },
        });
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('That suggestion already exists');
      }
      throw e;
    }
  }

  async updateUpsellRule(id: string, dto: UpdateUpsellRuleDto) {
    return this.prisma.tx(async (db) => {
      const existing = await db.upsellRule.findFirst({
        where: { id },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Upsell rule not found');
      return db.upsellRule.update({
        where: { id },
        data: {
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
        select: { id: true, isActive: true, sortOrder: true },
      });
    });
  }

  async deleteUpsellRule(id: string) {
    return this.prisma.tx(async (db) => {
      const existing = await db.upsellRule.findFirst({
        where: { id },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Upsell rule not found');
      await db.upsellRule.delete({ where: { id } });
      return { deleted: true };
    });
  }

  // ---------------------------------------------------------------- helpers

  /** Every id must be an ACTIVE product of this tenant (RLS-scoped). */
  private async assertProductsActive(db: TxClient, productIds: string[]) {
    const unique = [...new Set(productIds)];
    const found = await db.product.findMany({
      where: { id: { in: unique }, isActive: true },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      throw new BadRequestException('One or more products are unavailable');
    }
  }

  private async assertCategory(db: TxClient, categoryId: string) {
    const cat = await db.category.findFirst({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!cat) throw new BadRequestException('Unknown category');
  }
}

/** See catalogue.service.ts — Prisma 7 driver adapters moved this. */
function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002';
}
