import {
  annotate,
  matchItem,
  normalizeName,
  similarName,
  type ExistingProduct,
} from './menu-import.match';
import { RawMenuSchema } from './menu-import.types';

describe('normalizeName', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeName('  Veg   Momos! ')).toBe('veg momos');
  });
  it('folds diacritics rather than splitting them into spaces', () => {
    expect(normalizeName('Crème Brûlée')).toBe('creme brulee');
  });
});

describe('similarName', () => {
  it('treats a singular/plural slip as the same item', () => {
    expect(similarName('Paneer Momo', 'Paneer Momos')).toBe(true);
  });
  it('does not merge genuinely different items', () => {
    expect(similarName('Veg Momos', 'Paneer Momos')).toBe(false);
    expect(similarName('Classic Fries', 'Peri Peri Fries')).toBe(false);
  });
});

describe('matchItem', () => {
  const existing: ExistingProduct[] = [
    { id: 'p1', name: 'Paneer Momos', priceMinor: 8000 },
    { id: 'p2', name: 'Veg Momos', priceMinor: 5000 },
  ];

  it('flags a brand-new item', () => {
    expect(matchItem('Cold Coffee', 12000, existing)).toEqual({ kind: 'new' });
  });

  it('flags an exact match at the same price as a duplicate', () => {
    expect(matchItem('paneer momos', 8000, existing)).toEqual({
      kind: 'duplicate',
      productId: 'p1',
      existingPriceMinor: 8000,
    });
  });

  it('flags a known item at a new price as a price change', () => {
    expect(matchItem('Veg Momos', 6000, existing)).toEqual({
      kind: 'price_change',
      productId: 'p2',
      existingPriceMinor: 5000,
    });
  });

  it('matches a fuzzy name (Paneer Momo -> Paneer Momos)', () => {
    expect(matchItem('Paneer Momo', 8000, existing).productId).toBe('p1');
  });

  it('treats a null price against a known item as a duplicate, not a price change', () => {
    expect(matchItem('Veg Momos', null, existing).kind).toBe('duplicate');
  });
});

describe('annotate', () => {
  const existing: ExistingProduct[] = [
    { id: 'p2', name: 'Veg Momos', priceMinor: 5000 },
  ];
  const raw = RawMenuSchema.parse({
    categories: [
      {
        name: 'Momos',
        items: [
          { name: 'Veg Momos', price: 60 }, // 5000 -> 6000: price change
          { name: 'Cheese Momos', price: 100 }, // new
        ],
      },
    ],
  });

  it('converts rupees to paise and sets default actions from the match', () => {
    const out = annotate(raw, existing);
    const [veg, cheese] = out.categories[0].items;
    expect(veg.priceMinor).toBe(6000);
    expect(veg.match.kind).toBe('price_change');
    expect(veg.action).toBe('update');
    expect(cheese.priceMinor).toBe(10000);
    expect(cheese.match.kind).toBe('new');
    expect(cheese.action).toBe('create');
  });

  it('gives every item a unique session id', () => {
    const out = annotate(raw, existing);
    const ids = out.categories.flatMap((c) => c.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('RawMenuSchema (the strict gate in front of the catalogue)', () => {
  it('rejects a malformed AI response (missing name, non-numeric price)', () => {
    const bad = RawMenuSchema.safeParse({
      categories: [{ name: 'X', items: [{ price: 'free' }] }],
    });
    expect(bad.success).toBe(false);
  });

  it('defaults confidence when the model omits it', () => {
    const out = RawMenuSchema.parse({
      categories: [{ name: 'X', items: [{ name: 'Y', price: 10 }] }],
    });
    expect(out.categories[0].items[0].confidence).toBe(0.8);
    expect(out.categories[0].confidence).toBe(0.9);
  });
});
