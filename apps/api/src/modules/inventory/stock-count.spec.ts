import {
  countCode,
  missingReasons,
  reconcileCount,
  type SubmitLine,
} from './stock-count';

describe('reconcileCount', () => {
  const line = (
    ingredientId: string,
    countedQuantity: number,
    reason: SubmitLine['reason'] = null,
  ): SubmitLine => ({ ingredientId, countedQuantity, reason });

  it('records no difference when the count matches live stock', () => {
    const live = new Map([['paneer', 5000]]);
    expect(reconcileCount([line('paneer', 5000)], live)).toEqual([
      {
        ingredientId: 'paneer',
        countedQuantity: 5000,
        difference: 0,
        reason: null,
      },
    ]);
  });

  it('is negative for a shortage (counted below live stock)', () => {
    // System 4.2kg, counted 3.8kg → -0.4kg.
    const live = new Map([['paneer', 4200]]);
    expect(
      reconcileCount([line('paneer', 3800, 'WASTE_SPOILAGE')], live),
    ).toEqual([
      {
        ingredientId: 'paneer',
        countedQuantity: 3800,
        difference: -400,
        reason: 'WASTE_SPOILAGE',
      },
    ]);
  });

  it('is positive for a surplus (counted above live stock)', () => {
    const live = new Map([['veg', 5000]]);
    expect(
      reconcileCount([line('veg', 5300, 'COUNTING_ERROR')], live)[0].difference,
    ).toBe(300);
  });

  it('handles a count down to zero', () => {
    const live = new Map([['spice', 2000]]);
    expect(
      reconcileCount([line('spice', 0, 'THEFT')], live)[0].difference,
    ).toBe(-2000);
  });

  it('treats an ingredient with no ledger rows as zero stock', () => {
    // Never purchased/moved → not in the map → counting 500 is a +500 surplus.
    expect(
      reconcileCount([line('new-item', 500, 'OTHER')], new Map())[0].difference,
    ).toBe(500);
  });

  // The concurrency guarantee (§5/§6): the adjustment reconciles against LIVE
  // stock at submit time, never the snapshot taken when the count started. A
  // 2kg sale during the count already lowered the ledger from 10kg to 8kg, so a
  // physical count of 7kg is a genuine 1kg shrinkage — NOT the 3kg a naive
  // (counted − snapshot) would wrongly write, which would double-count the sale.
  it('reconciles against live stock, not the start snapshot (concurrent sale)', () => {
    const liveAfterSale = new Map([['paneer', 8000]]); // 10000 − 2000 sold mid-count
    expect(
      reconcileCount(
        [line('paneer', 7000, 'UNRECORDED_USAGE')],
        liveAfterSale,
      )[0].difference,
    ).toBe(-1000);
  });

  it('reconciles a whole count independently per ingredient', () => {
    const live = new Map([
      ['paneer', 4200],
      ['veg', 8000],
    ]);
    const out = reconcileCount(
      [
        line('paneer', 3800, 'DAMAGED'),
        line('veg', 8400, 'RECEIVING_DISCREPANCY'),
      ],
      live,
    );
    expect(out.map((r) => r.difference)).toEqual([-400, 400]);
  });
});

describe('missingReasons', () => {
  it('flags a non-zero adjustment with no reason', () => {
    const adj = reconcileCount(
      [{ ingredientId: 'paneer', countedQuantity: 3800, reason: null }],
      new Map([['paneer', 4200]]),
    );
    expect(missingReasons(adj)).toEqual(['paneer']);
  });

  it('does not require a reason when there is no difference', () => {
    const adj = reconcileCount(
      [{ ingredientId: 'paneer', countedQuantity: 4200, reason: null }],
      new Map([['paneer', 4200]]),
    );
    expect(missingReasons(adj)).toEqual([]);
  });

  it('accepts a non-zero adjustment that carries a reason', () => {
    const adj = reconcileCount(
      [
        {
          ingredientId: 'paneer',
          countedQuantity: 3800,
          reason: 'WASTE_SPOILAGE',
        },
      ],
      new Map([['paneer', 4200]]),
    );
    expect(missingReasons(adj)).toEqual([]);
  });
});

describe('countCode', () => {
  it('formats as SC-YYMMDD-XXXX', () => {
    expect(countCode(new Date('2026-08-18T10:30:00Z'), 'k3q9')).toBe(
      'SC-260818-K3Q9',
    );
    expect(countCode(new Date('2026-08-18T10:30:00Z'))).toMatch(
      /^SC-260818-[A-Z0-9]{4}$/,
    );
  });
});
