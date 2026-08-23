/**
 * Seeds the Ora Momos menu into the existing catalogue (categories + products).
 *
 * Run (validate the data only, no DB):
 *   pnpm --filter @oraos/api ts-node prisma/seed-ora-momos.ts --validate
 * Run (import into the tenant):
 *   pnpm --filter @oraos/api ts-node prisma/seed-ora-momos.ts
 *
 * Idempotent by design (acceptance §24):
 *   - categories upserted by (restaurantId, name); sortOrder set on CREATE only
 *     so a re-run never reshuffles an order the owner has since arranged.
 *   - products created only when missing. An existing product is LEFT UNCHANGED:
 *     if its price differs from the menu it is reported, never silently
 *     overwritten (§13). Pass --sync-prices to opt into updating prices.
 *   - never deletes, never deactivates, never touches another tenant.
 *
 * Uses the OWNER connection (DATABASE_URL, BYPASSRLS) exactly like seed.ts:
 * catalogue rows are tenant-scoped, so restaurantId is supplied explicitly on
 * every write and RLS is bypassed for the seed rather than juggling app.* GUCs.
 *
 * Money is integer paise: ₹50 -> 5000. taxRateBp / isActive / isPopular are
 * left to their schema defaults (500 / true / false) — the menu prices nothing
 * else and "Popular" is an explicit owner setting, never implied by import (§16).
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

// --------------------------------------------------------------------------
// The menu — the single source of truth, in the exact order of the physical
// card. Prices are in rupees here (converted to paise on write). `variants`
// marks the Veg/Paneer/Cheese matrix categories; each entry then prices the
// three variants independently (the deltas are not constant across rows, which
// is precisely why these are distinct products and not one modifier group).
// --------------------------------------------------------------------------

type VariantPrices = { veg: number; paneer: number; cheese: number };
type MatrixItem = { base: string; prices: VariantPrices };
type SimpleItem = { name: string; price: number };

type MenuCategory =
  | { name: string; variants: true; items: MatrixItem[] }
  | { name: string; variants?: false; items: SimpleItem[] };

const MENU: MenuCategory[] = [
  {
    name: 'Momos',
    variants: true,
    items: [
      { base: 'Classic Steam', prices: { veg: 50, paneer: 60, cheese: 80 } },
      { base: 'Classic Steam Peri Peri', prices: { veg: 60, paneer: 70, cheese: 85 } },
      { base: 'Golden Fried', prices: { veg: 70, paneer: 80, cheese: 90 } },
      { base: 'Golden Fried Peri Peri', prices: { veg: 80, paneer: 90, cheese: 100 } },
      { base: 'Chatpata Momos', prices: { veg: 90, paneer: 100, cheese: 110 } },
      { base: 'Tandoori Smokey', prices: { veg: 110, paneer: 130, cheese: 140 } },
      { base: 'Tandoori Smokey Peri Peri', prices: { veg: 120, paneer: 140, cheese: 150 } },
      { base: 'Crunchy Kurkure', prices: { veg: 110, paneer: 130, cheese: 140 } },
      { base: 'Crunchy Kurkure Peri Peri', prices: { veg: 120, paneer: 130, cheese: 140 } },
      { base: 'Creamy Malai', prices: { veg: 120, paneer: 130, cheese: 140 } },
      { base: 'Afghani Malai', prices: { veg: 130, paneer: 140, cheese: 150 } },
    ],
  },
  {
    name: 'Jhol Momos',
    variants: true,
    items: [
      { base: 'Jhol Steam', prices: { veg: 100, paneer: 120, cheese: 140 } },
      // Menu shows two "Cheese Loaded Jhol" rows with different prices. The DB
      // cannot hold two products with the same name (unique[restaurantId,name]),
      // and the layout distinguishes them: this first row sits in the STEAM
      // group (below Jhol Steam), the second in the FRIED group (below Jhol
      // Fried), with the fried row +₹10 across every variant — the same +₹10
      // that separates Jhol Fried from Jhol Steam. So they are the steamed vs
      // fried cheese-loaded jhol. Named accordingly and FLAGGED in the report;
      // rename freely if the owner labels them differently.
      { base: 'Cheese Loaded Jhol Steam', prices: { veg: 140, paneer: 160, cheese: 180 } },
      { base: 'Jhol Fried', prices: { veg: 110, paneer: 130, cheese: 150 } },
      { base: 'Cheese Loaded Jhol Fried', prices: { veg: 150, paneer: 170, cheese: 190 } },
    ],
  },
  {
    name: 'Authentic Jhol',
    items: [{ name: 'Authentic Jhol', price: 199 }],
  },
  {
    name: 'Chocolate Bowl',
    items: [
      { name: 'Midnight Dark Choco Bowl', price: 80 },
      { name: 'Lava Delight Choco Bowl', price: 80 },
      { name: 'Snowy White Choco Bowl', price: 90 },
      { name: 'Mixed Chocolate Bowl', price: 100 },
      { name: 'Oreo Chocolate Bowl', price: 110 },
      { name: 'KitKat Chocolate Bowl', price: 110 },
    ],
  },
  {
    // Portion note on the card ("2 Fried / 2 Kurkure / 2 Tandoori / 2 Malai /
    // 8 pieces") is intentionally not stored: Product has no description field
    // and inventing one for this import is out of scope (§20).
    name: 'Momos Platter',
    items: [
      { name: 'Veg Platter', price: 120 },
      { name: 'Veg Platter Peri Peri', price: 130 },
      { name: 'Paneer Platter', price: 130 },
      { name: 'Paneer Platter Peri Peri', price: 140 },
      { name: 'Cheese Platter', price: 150 },
      { name: 'Cheese Platter Peri Peri', price: 160 },
    ],
  },
  {
    name: 'Long Fries',
    items: [
      { name: 'Classic Salted', price: 60 },
      { name: 'Peri Peri Fries', price: 70 },
      { name: 'Creamy Gravy Fries', price: 100 },
      { name: 'Cheese Loaded Long Fries', price: 100 },
      { name: 'Peri Peri Loaded Fries', price: 120 },
    ],
  },
  {
    name: 'Cheese Balls',
    items: [
      { name: 'Crunchy Cheese Ball', price: 80 },
      { name: 'Crunchy Cheese Ball Peri Peri', price: 90 },
      { name: 'Chatpata Cheese Shot', price: 100 },
      { name: 'Creamy Cheese Pops', price: 130 },
    ],
  },
  {
    name: 'Potato Twister',
    items: [
      { name: 'Potato Twister', price: 50 },
      { name: 'Peri Peri Twister', price: 70 },
    ],
  },
];

/** One flat product to write: which category, its name, price (paise), order. */
type PlannedProduct = {
  category: string;
  name: string;
  priceMinor: number;
  sortOrder: number;
};

/** Expand the menu into an ordered flat list. Variant rows become three
 *  distinct products "<Variant> <Base>"; sortOrder preserves card order. */
function planProducts(): PlannedProduct[] {
  const out: PlannedProduct[] = [];
  for (const cat of MENU) {
    let order = 0;
    if (cat.variants) {
      for (const item of cat.items) {
        for (const [label, variant] of [
          ['Veg', 'veg'],
          ['Paneer', 'paneer'],
          ['Cheese', 'cheese'],
        ] as const) {
          out.push({
            category: cat.name,
            name: `${label} ${item.base}`,
            priceMinor: item.prices[variant] * 100,
            sortOrder: order++,
          });
        }
      }
    } else {
      for (const item of cat.items) {
        out.push({
          category: cat.name,
          name: item.name,
          priceMinor: item.price * 100,
          sortOrder: order++,
        });
      }
    }
  }
  return out;
}

/** Pure self-check — the runnable guard for the data (no DB). Throws on any
 *  problem the DB would otherwise reject or that would corrupt the import. */
function validate(plan: PlannedProduct[]): void {
  const seen = new Set<string>();
  for (const p of plan) {
    const key = `${p.category} ${p.name}`;
    if (seen.has(key)) throw new Error(`Duplicate product name: ${p.name} in ${p.category}`);
    seen.add(key);
    // Names are also globally unique per tenant; catch cross-category dupes too.
    if (p.priceMinor <= 0 || !Number.isInteger(p.priceMinor)) {
      throw new Error(`Bad price for ${p.name}: ${p.priceMinor}`);
    }
  }
  const globalNames = new Set<string>();
  for (const p of plan) {
    if (globalNames.has(p.name)) throw new Error(`Product name not unique across catalogue: ${p.name}`);
    globalNames.add(p.name);
  }
  const EXPECTED_CATEGORIES = 8;
  const EXPECTED_PRODUCTS = 69;
  const cats = new Set(plan.map((p) => p.category));
  if (cats.size !== EXPECTED_CATEGORIES) {
    throw new Error(`Expected ${EXPECTED_CATEGORIES} categories, got ${cats.size}`);
  }
  if (plan.length !== EXPECTED_PRODUCTS) {
    throw new Error(`Expected ${EXPECTED_PRODUCTS} products, got ${plan.length}`);
  }
}

// --------------------------------------------------------------------------
// Tenant resolution — never hard-coded, never guessed when ambiguous (§1, §22).
// --------------------------------------------------------------------------

async function resolveTenant(prisma: PrismaClient): Promise<{ id: string; name: string; slug: string }> {
  const byId = process.env.ORA_MOMOS_RESTAURANT_ID;
  if (byId) {
    const r = await prisma.restaurant.findUnique({
      where: { id: byId },
      select: { id: true, name: true, slug: true },
    });
    if (!r) throw new Error(`ORA_MOMOS_RESTAURANT_ID=${byId} matches no restaurant`);
    return r;
  }
  const bySlug = process.env.ORA_MOMOS_SLUG;
  const all = await prisma.restaurant.findMany({
    select: { id: true, name: true, slug: true },
  });
  const candidates = bySlug
    ? all.filter((r) => r.slug === bySlug)
    : all.filter((r) => r.slug === 'ora-momos' || /ora\s*momos/i.test(r.name));

  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new Error(
      'Could not identify the Ora Momos tenant. Existing restaurants:\n' +
        all.map((r) => `  ${r.id}  ${JSON.stringify(r.name)}  slug=${r.slug}`).join('\n') +
        '\nRe-run with ORA_MOMOS_RESTAURANT_ID=<id> to name the target explicitly.',
    );
  }
  throw new Error(
    'Ambiguous: multiple restaurants match Ora Momos:\n' +
      candidates.map((r) => `  ${r.id}  ${JSON.stringify(r.name)}  slug=${r.slug}`).join('\n') +
      '\nRe-run with ORA_MOMOS_RESTAURANT_ID=<id> to name the target explicitly.',
  );
}

async function main() {
  const plan = planProducts();
  validate(plan);

  if (process.argv.includes('--validate')) {
    console.log(`Validated: 8 categories, ${plan.length} products, prices in paise, no duplicate names.`);
    return;
  }

  const syncPrices = process.argv.includes('--sync-prices');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const tenant = await resolveTenant(prisma);
    const maskedId = `${tenant.id.slice(0, 8)}…${tenant.id.slice(-4)}`;
    console.log(`Target tenant: ${JSON.stringify(tenant.name)} slug=${tenant.slug} (${maskedId})`);

    // 1) Categories — upsert by (restaurantId, name); sortOrder on create only.
    const categoryId = new Map<string, string>();
    let categoriesCreated = 0;
    for (const [index, cat] of MENU.entries()) {
      const existing = await prisma.category.findUnique({
        where: { restaurantId_name: { restaurantId: tenant.id, name: cat.name } },
        select: { id: true },
      });
      if (existing) {
        categoryId.set(cat.name, existing.id);
      } else {
        const created = await prisma.category.create({
          data: { restaurantId: tenant.id, name: cat.name, sortOrder: index },
          select: { id: true },
        });
        categoryId.set(cat.name, created.id);
        categoriesCreated++;
      }
    }

    // 2) Products — create when missing; report (never overwrite) on mismatch.
    let created = 0;
    let matched = 0;
    const priceChanges: Array<{ name: string; existingMinor: number; menuMinor: number }> = [];
    for (const p of plan) {
      const catId = categoryId.get(p.category)!;
      const existing = await prisma.product.findUnique({
        where: { restaurantId_name: { restaurantId: tenant.id, name: p.name } },
        select: { id: true, priceMinor: true, categoryId: true },
      });
      if (!existing) {
        await prisma.product.create({
          data: {
            restaurantId: tenant.id,
            categoryId: catId,
            name: p.name,
            priceMinor: p.priceMinor,
            sortOrder: p.sortOrder,
          },
        });
        created++;
        continue;
      }
      matched++;
      if (existing.priceMinor !== p.priceMinor) {
        priceChanges.push({ name: p.name, existingMinor: existing.priceMinor, menuMinor: p.priceMinor });
        if (syncPrices) {
          await prisma.product.update({
            where: { id: existing.id },
            data: { priceMinor: p.priceMinor },
          });
        }
      }
    }

    // ---- Report ----
    console.log('\nORA MOMOS MENU — IMPORT COMPLETE');
    console.log(`Categories:        8 (${categoriesCreated} created, ${8 - categoriesCreated} already present)`);
    console.log(`Products/variants: ${plan.length}`);
    console.log(`Created:           ${created}`);
    console.log(`Existing matched:  ${matched}`);
    console.log(`Duplicates prevented: ${matched}`);
    console.log(`Price ${syncPrices ? 'changes applied' : 'mismatches (left unchanged)'}: ${priceChanges.length}`);
    for (const c of priceChanges) {
      console.log(`   - ${c.name}: existing ₹${c.existingMinor / 100} vs menu ₹${c.menuMinor / 100}`);
    }
    console.log(`Production tenant: ${maskedId}`);
    console.log(
      '\nNote: "Cheese Loaded Jhol" appears twice on the card with different prices; ' +
        'imported as "Cheese Loaded Jhol Steam" (₹140/160/180) and "Cheese Loaded Jhol Fried" ' +
        '(₹150/170/190) per the steam/fried grouping. Rename if the owner labels them otherwise.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
