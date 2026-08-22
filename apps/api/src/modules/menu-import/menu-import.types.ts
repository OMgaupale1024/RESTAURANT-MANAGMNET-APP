import { z } from 'zod';

/**
 * The two shapes the scanner speaks in, and the one-way door between them.
 *
 * RawMenu is what a provider returns: prices in the menu's own units (rupees),
 * as a number or null — NEVER paise. RawMenuSchema is the strict gate in front
 * of the catalogue (spec §5): a malformed model response fails validation here
 * and never becomes a product.
 *
 * ReviewMenu is the working menu the human edits and the import writes: prices
 * already converted to paise and each item annotated against the existing
 * catalogue. It is validated AGAIN on the way into import, so an edited draft
 * cannot smuggle a bad shape past the transaction either.
 */

export const MATCH_KINDS = ['new', 'duplicate', 'price_change'] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

export const IMPORT_ACTIONS = ['create', 'update', 'skip'] as const;
export type ImportAction = (typeof IMPORT_ACTIONS)[number];

// --- Raw (provider output) --------------------------------------------------

export const RawItemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Rupees as printed on the menu, or null when no price is shown.
  price: z.number().nonnegative().max(100_000).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  quantity: z.string().trim().max(60).nullable().optional(),
  variant: z.string().trim().max(60).nullable().optional(),
  veg: z.boolean().nullable().optional(),
  spicy: z.boolean().nullable().optional(),
  // How sure the model is, 0..1. Defaulted so a provider that omits it still
  // validates; the review UI flags the low ones (spec §8).
  confidence: z.number().min(0).max(1).default(0.8),
});
export type RawItem = z.infer<typeof RawItemSchema>;

export const RawCategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  confidence: z.number().min(0).max(1).default(0.9),
  items: z.array(RawItemSchema).max(300),
});

export const RawMenuSchema = z.object({
  categories: z.array(RawCategorySchema).max(60),
});
export type RawMenu = z.infer<typeof RawMenuSchema>;

// --- Review (working menu, edited and imported) -----------------------------

export const ReviewMatchSchema = z.object({
  kind: z.enum(['new', 'duplicate', 'price_change']),
  productId: z.string().uuid().optional(),
  existingPriceMinor: z.number().int().optional(),
});

export const ReviewItemSchema = z.object({
  // Session-local id, for stable React keys and edit targeting. NOT a db id.
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  // Paise, or null when the scan found no price (the review UI makes the user
  // fill it in before the item can be imported).
  priceMinor: z.number().int().min(0).max(10_000_000).nullable(),
  description: z.string().trim().max(500).nullable().optional(),
  quantity: z.string().trim().max(60).nullable().optional(),
  variant: z.string().trim().max(60).nullable().optional(),
  veg: z.boolean().nullable().optional(),
  spicy: z.boolean().nullable().optional(),
  confidence: z.number().min(0).max(1),
  action: z.enum(['create', 'update', 'skip']),
  match: ReviewMatchSchema,
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;

export const ReviewCategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  items: z.array(ReviewItemSchema).max(300),
});
export type ReviewCategory = z.infer<typeof ReviewCategorySchema>;

export const ReviewMenuSchema = z.object({
  categories: z.array(ReviewCategorySchema).max(60),
});
export type ReviewMenu = z.infer<typeof ReviewMenuSchema>;

/** Rupees → paise. Integer minor units, like every price in this system. */
export function rupeesToMinor(
  rupees: number | null | undefined,
): number | null {
  if (rupees === null || rupees === undefined) return null;
  return Math.round(rupees * 100);
}
