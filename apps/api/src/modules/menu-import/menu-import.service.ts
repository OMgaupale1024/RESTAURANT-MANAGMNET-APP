import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { EventsService } from '../../events/events.service';
import {
  MenuExtractionError,
  MenuExtractionService,
} from './menu-extraction.service';
import { annotate, normalizeName } from './menu-import.match';
import { ReviewMenuSchema, type ReviewMenu } from './menu-import.types';

const MAX_PAGES = 8;
// ~2.25 MB of binary per image once base64-decoded. A downscaled menu photo is
// far smaller; this is the abuse ceiling, paired with the 12mb body cap.
const MAX_IMAGE_CHARS = 3_000_000;
const DATA_URL = /^data:image\/(jpe?g|png|webp);base64,[A-Za-z0-9+/=]+$/;

const SESSION_SELECT = {
  id: true,
  status: true,
  pageCount: true,
  result: true,
  error: true,
  importedAt: true,
  createdAt: true,
} satisfies Prisma.MenuImportSessionSelect;

@Injectable()
export class MenuImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly extraction: MenuExtractionService,
    private readonly events: EventsService,
  ) {}

  /**
   * Extract → annotate → store. The vision call runs OUTSIDE any transaction —
   * a 60s network round-trip must never hold a database connection open.
   */
  async extract(images: string[]) {
    this.validateImages(images);
    const ctx = this.prisma.requireContext();

    const session = await this.prisma.tx((db) =>
      db.menuImportSession.create({
        data: {
          restaurantId: ctx.restaurantId,
          status: 'PROCESSING',
          pageCount: images.length,
          createdBy: ctx.userId,
        },
        select: { id: true },
      }),
    );

    try {
      const raw = await this.extraction.extract(images);
      const existing = await this.prisma.tx((db) =>
        db.product.findMany({
          select: { id: true, name: true, priceMinor: true },
        }),
      );
      const result = annotate(raw, existing);

      return await this.prisma.tx((db) =>
        db.menuImportSession.update({
          where: { id: session.id },
          data: {
            status: 'REVIEW_REQUIRED',
            result: result,
            error: null,
          },
          select: SESSION_SELECT,
        }),
      );
    } catch (e) {
      const message =
        e instanceof MenuExtractionError
          ? e.message
          : 'Something went wrong reading the menu.';
      await this.markFailed(session.id, message);
      if (e instanceof MenuExtractionError) {
        throw new UnprocessableEntityException(message);
      }
      throw e;
    }
  }

  async get(id: string) {
    return this.prisma.tx(async (db) => {
      const session = await db.menuImportSession.findFirst({
        where: { id },
        select: SESSION_SELECT,
      });
      // Another tenant's session does not exist here (RLS) — same 404 as a bad
      // id, so this cannot probe which ids are real.
      if (!session) throw new NotFoundException('Import session not found');
      return session;
    });
  }

  async saveDraft(id: string, result: unknown) {
    const menu = this.parseMenu(result);
    return this.prisma.tx(async (db) => {
      const session = await db.menuImportSession.findFirst({
        where: { id },
        select: { id: true, status: true },
      });
      if (!session) throw new NotFoundException('Import session not found');
      this.assertMutable(session.status);
      return db.menuImportSession.update({
        where: { id },
        data: { result: menu },
        select: SESSION_SELECT,
      });
    });
  }

  async cancel(id: string) {
    return this.prisma.tx(async (db) => {
      const session = await db.menuImportSession.findFirst({
        where: { id },
        select: { id: true, status: true },
      });
      if (!session) throw new NotFoundException('Import session not found');
      if (session.status === 'IMPORTED') {
        throw new ConflictException('An imported menu cannot be cancelled.');
      }
      return db.menuImportSession.update({
        where: { id },
        data: { status: 'CANCELLED' },
        select: SESSION_SELECT,
      });
    });
  }

  /**
   * Write the reviewed menu to the catalogue in ONE transaction (spec §13, §21).
   * Categories are found-or-created; each selected item creates a new product or
   * updates an existing one; an existing item is NEVER deleted (spec §12, §19).
   * If anything throws, the whole thing rolls back and the session stays exactly
   * where it was — the user retries the same session (spec §25).
   */
  async import(id: string, result: unknown) {
    const menu = this.parseMenu(result);
    const ctx = this.prisma.requireContext();

    // Create/update items need a price. Checked before the tx so the error is
    // clean, not a rolled-back half-write.
    for (const c of menu.categories) {
      for (const it of c.items) {
        if (it.action !== 'skip' && it.priceMinor === null) {
          throw new BadRequestException(
            `"${it.name}" needs a price before it can be imported.`,
          );
        }
      }
    }

    return this.prisma.tx(async (db) => {
      const session = await db.menuImportSession.findFirst({
        where: { id },
        select: { id: true, status: true },
      });
      if (!session) throw new NotFoundException('Import session not found');
      if (session.status === 'IMPORTED') {
        throw new ConflictException('This menu has already been imported.');
      }
      if (session.status === 'CANCELLED') {
        throw new ConflictException('This import was cancelled.');
      }

      // Existing categories and products, keyed by normalised name. Kept in
      // memory and updated as we create, so a name collision never reaches the
      // unique index — a failed statement inside a transaction poisons the whole
      // transaction, so we must not rely on catching one. Serial, never
      // Promise.all: the tx shares one pg connection.
      const cats = await db.category.findMany({
        select: { id: true, name: true },
      });
      const prods = await db.product.findMany({
        select: { id: true, name: true },
      });
      const catIdByNorm = new Map(
        cats.map((c) => [normalizeName(c.name), c.id]),
      );
      const productIdByNorm = new Map(
        prods.map((p) => [normalizeName(p.name), p.id]),
      );

      const ensureCategory = async (name: string): Promise<string> => {
        const norm = normalizeName(name);
        const found = catIdByNorm.get(norm);
        if (found) return found;
        const cat = await db.category.create({
          data: { restaurantId: ctx.restaurantId, name },
          select: { id: true },
        });
        catIdByNorm.set(norm, cat.id);
        return cat.id;
      };

      let created = 0;
      let updated = 0;
      let skipped = 0;

      for (const c of menu.categories) {
        const toWrite = c.items.filter((it) => it.action !== 'skip');
        skipped += c.items.length - toWrite.length;
        if (toWrite.length === 0) continue;
        const categoryId = await ensureCategory(c.name);

        for (const it of toWrite) {
          const norm = normalizeName(it.name);
          const targetId =
            (it.action === 'update' ? it.match.productId : undefined) ??
            productIdByNorm.get(norm);
          // Non-null asserted: the pre-tx loop rejected any non-skip null price.
          const priceMinor = it.priceMinor as number;
          if (targetId) {
            // Update the price and reactivate — never rename or delete.
            await db.product.update({
              where: { id: targetId },
              data: { priceMinor, isActive: true, categoryId },
            });
            productIdByNorm.set(norm, targetId);
            updated++;
          } else {
            const p = await db.product.create({
              data: {
                restaurantId: ctx.restaurantId,
                name: it.name,
                priceMinor,
                categoryId,
              },
              select: { id: true },
            });
            productIdByNorm.set(norm, p.id);
            created++;
          }
        }
      }

      await this.events.record(db, {
        action: 'menu.imported',
        entityType: 'menu_import_session',
        entityId: id,
        metadata: {
          created,
          updated,
          skipped,
          provider: this.extraction.providerName,
        },
      });

      const finished = await db.menuImportSession.update({
        where: { id },
        data: {
          status: 'IMPORTED',
          importedAt: new Date(),
          result: menu,
          error: null,
        },
        select: SESSION_SELECT,
      });

      return { session: finished, summary: { created, updated, skipped } };
    });
  }

  // --- helpers --------------------------------------------------------------

  private parseMenu(result: unknown): ReviewMenu {
    const parsed = ReviewMenuSchema.safeParse(result);
    if (!parsed.success) {
      throw new BadRequestException('The menu is not in a valid shape.');
    }
    return parsed.data;
  }

  private assertMutable(status: string) {
    if (status === 'IMPORTED') {
      throw new ConflictException('This menu has already been imported.');
    }
    if (status === 'CANCELLED') {
      throw new ConflictException('This import was cancelled.');
    }
  }

  private async markFailed(id: string, message: string) {
    // Best-effort: never mask the original failure with a bookkeeping error.
    try {
      await this.prisma.tx((db) =>
        db.menuImportSession.update({
          where: { id },
          data: { status: 'FAILED', error: message.slice(0, 500) },
        }),
      );
    } catch {
      /* swallow — the caller is already throwing the real error */
    }
  }

  private validateImages(images: string[]) {
    if (images.length === 0) {
      throw new BadRequestException('Add at least one photo.');
    }
    if (images.length > MAX_PAGES) {
      throw new BadRequestException(`Up to ${MAX_PAGES} pages at a time.`);
    }
    for (const img of images) {
      if (img.length > MAX_IMAGE_CHARS) {
        throw new BadRequestException(
          'One of the images is too large. Retake it a little smaller.',
        );
      }
      if (!DATA_URL.test(img)) {
        throw new BadRequestException('Images must be JPG, PNG, or WEBP.');
      }
    }
  }
}
