import { BadRequestException } from '@nestjs/common';
import {
  allocateFefo,
  batchCode,
  batchCost,
  findShortfalls,
  scaleComponents,
  yieldVariance,
  type LiveBatch,
} from './prep';

describe('scaleComponents', () => {
  const recipe = [
    { ingredientId: 'paneer', quantity: 1000 }, // 1kg per 1.1kg standard
    { ingredientId: 'veg', quantity: 200 },
    { ingredientId: 'spice', quantity: 50 },
  ];

  it('returns the recipe unchanged at the standard yield', () => {
    expect(scaleComponents(recipe, 1100, 1100)).toEqual(recipe);
  });

  it('scales consumption proportionally to the planned yield', () => {
    // Double batch: 2200g planned from an 1100g standard → 2× every component.
    expect(scaleComponents(recipe, 1100, 2200)).toEqual([
      { ingredientId: 'paneer', quantity: 2000 },
      { ingredientId: 'veg', quantity: 400 },
      { ingredientId: 'spice', quantity: 100 },
    ]);
  });

  it('rounds to whole base units', () => {
    // 1500/1100 = 1.3636…; paneer 1000×→1364, spice 50×→68.
    const scaled = scaleComponents(recipe, 1100, 1500);
    expect(scaled[0].quantity).toBe(1364);
    expect(scaled[2].quantity).toBe(68);
  });

  it('rejects a recipe with no standard yield and a non-positive batch', () => {
    expect(() => scaleComponents(recipe, 0, 1000)).toThrow(BadRequestException);
    expect(() => scaleComponents(recipe, 1100, 0)).toThrow(BadRequestException);
  });
});

describe('yieldVariance', () => {
  it('reports a shortfall as a negative delta and percent', () => {
    // -200/3200 = -6.25%; Math.round(-62.5) = -62 in JS → -6.2.
    expect(yieldVariance(3200, 3000)).toEqual({ delta: -200, pct: -6.2 });
  });
  it('reports an overproduction as positive', () => {
    expect(yieldVariance(1000, 1100)).toEqual({ delta: 100, pct: 10 });
  });
  it('has no percent when nothing was expected', () => {
    expect(yieldVariance(0, 500)).toEqual({ delta: 500, pct: null });
  });
});

describe('findShortfalls', () => {
  const need = [
    { ingredientId: 'paneer', quantity: 2700 },
    { ingredientId: 'veg', quantity: 400 },
  ];

  it('is empty when everything is in stock', () => {
    const stock = new Map([
      ['paneer', 5000],
      ['veg', 800],
    ]);
    expect(findShortfalls(need, stock)).toEqual([]);
  });

  it('reports each short component with the gap', () => {
    const stock = new Map([
      ['paneer', 1900],
      ['veg', 800],
    ]);
    expect(findShortfalls(need, stock)).toEqual([
      { ingredientId: 'paneer', need: 2700, available: 1900, short: 800 },
    ]);
  });

  it('treats a missing ingredient as zero stock', () => {
    expect(findShortfalls(need, new Map())).toHaveLength(2);
  });
});

describe('allocateFefo', () => {
  const now = new Date('2026-08-15T12:00:00Z');
  const mk = (
    id: string,
    remaining: number,
    expiresAt: string | null,
    createdAt: string,
  ): LiveBatch => ({
    id,
    remaining,
    expiresAt: expiresAt ? new Date(expiresAt) : null,
    createdAt: new Date(createdAt),
  });

  it('consumes the earliest-expiring batch first (FEFO)', () => {
    const batches = [
      mk('late', 1000, '2026-08-15T21:00:00Z', '2026-08-15T09:00:00Z'),
      mk('soon', 1000, '2026-08-15T17:00:00Z', '2026-08-15T10:00:00Z'),
    ];
    expect(allocateFefo(batches, 500, now)).toEqual([
      { prepBatchId: 'soon', quantity: 500 },
    ]);
  });

  it('spills across batches in expiry order when one is not enough', () => {
    const batches = [
      mk('soon', 300, '2026-08-15T17:00:00Z', '2026-08-15T10:00:00Z'),
      mk('late', 1000, '2026-08-15T21:00:00Z', '2026-08-15T09:00:00Z'),
    ];
    expect(allocateFefo(batches, 500, now)).toEqual([
      { prepBatchId: 'soon', quantity: 300 },
      { prepBatchId: 'late', quantity: 200 },
    ]);
  });

  it('never draws an expired batch, and returns the shortfall as a null remainder', () => {
    const batches = [
      mk('expired', 1000, '2026-08-15T06:00:00Z', '2026-08-14T10:00:00Z'),
      mk('fresh', 200, '2026-08-15T20:00:00Z', '2026-08-15T09:00:00Z'),
    ];
    // 500 needed, only 200 fresh: 200 from fresh, 300 uncovered (NOT the expired 1000).
    expect(allocateFefo(batches, 500, now)).toEqual([
      { prepBatchId: 'fresh', quantity: 200 },
      { prepBatchId: null, quantity: 300 },
    ]);
  });

  it('falls back to FIFO by prepared time when no batch has an expiry', () => {
    const batches = [
      mk('newer', 1000, null, '2026-08-15T11:00:00Z'),
      mk('older', 1000, null, '2026-08-15T08:00:00Z'),
    ];
    expect(allocateFefo(batches, 400, now)).toEqual([
      { prepBatchId: 'older', quantity: 400 },
    ]);
  });

  it('ignores depleted batches and no-op allocates for a non-positive need', () => {
    const batches = [mk('empty', 0, null, '2026-08-15T08:00:00Z')];
    expect(allocateFefo(batches, 100, now)).toEqual([
      { prepBatchId: null, quantity: 100 },
    ]);
    expect(allocateFefo(batches, 0, now)).toEqual([]);
  });
});

describe('batchCost', () => {
  const components = [
    { ingredientId: 'paneer', quantity: 2700 },
    { ingredientId: 'veg', quantity: 400 },
  ];

  it('sums component quantity × unit cost, rounded to paise', () => {
    // paneer ₹4/g? no — paise per base unit. 0.1481 paise/g etc; use round numbers:
    const unitCost = new Map([
      ['paneer', 0.15], // paise per gram
      ['veg', 0.2],
    ]);
    // 2700×0.15 + 400×0.2 = 405 + 80 = 485
    expect(batchCost(components, unitCost)).toBe(485);
  });

  it('is null when any component has no cost basis', () => {
    const unitCost = new Map([['paneer', 0.15]]); // veg missing
    expect(batchCost(components, unitCost)).toBeNull();
  });
});

describe('batchCode', () => {
  it('formats as PB-YYMMDD-XXXX', () => {
    expect(batchCode(new Date('2026-08-15T10:30:00Z'), 'k3q9')).toBe(
      'PB-260815-K3Q9',
    );
    expect(batchCode(new Date('2026-08-15T10:30:00Z'))).toMatch(
      /^PB-260815-[A-Z0-9]{4}$/,
    );
  });
});
