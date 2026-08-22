import { BadRequestException } from '@nestjs/common';
import { resolveModifierSelection, type ModifierGroupDef } from './modifiers';

const style: ModifierGroupDef = {
  id: 'g-style',
  name: 'Style',
  minSelect: 1,
  maxSelect: 1,
  options: [
    { id: 'o-steamed', name: 'Steamed', priceAdjustMinor: 0 },
    { id: 'o-fried', name: 'Fried', priceAdjustMinor: 0 },
    { id: 'o-tandoori', name: 'Tandoori', priceAdjustMinor: 2000 },
  ],
};

const addons: ModifierGroupDef = {
  id: 'g-addons',
  name: 'Add-ons',
  minSelect: 0,
  maxSelect: 2,
  options: [
    { id: 'o-chutney', name: 'Extra Chutney', priceAdjustMinor: 1000 },
    { id: 'o-mayo', name: 'Mayo', priceAdjustMinor: 1500 },
    { id: 'o-cheese', name: 'Cheese', priceAdjustMinor: 2500 },
  ],
};

describe('resolveModifierSelection', () => {
  it('prices a required single choice plus optional add-ons', () => {
    const r = resolveModifierSelection(
      [style, addons],
      ['o-tandoori', 'o-chutney'],
    );
    expect(r.perUnitAdjustMinor).toBe(3000); // 2000 + 1000
    expect(r.snapshot).toEqual([
      {
        optionId: 'o-tandoori',
        groupName: 'Style',
        optionName: 'Tandoori',
        priceAdjustMinor: 2000,
      },
      {
        optionId: 'o-chutney',
        groupName: 'Add-ons',
        optionName: 'Extra Chutney',
        priceAdjustMinor: 1000,
      },
    ]);
  });

  it('zero adjustment and empty snapshot when nothing costs extra', () => {
    const r = resolveModifierSelection([style, addons], ['o-steamed']);
    expect(r.perUnitAdjustMinor).toBe(0);
    expect(r.snapshot).toHaveLength(1);
  });

  it('rejects too few in a required group (choose 1)', () => {
    expect(() => resolveModifierSelection([style, addons], [])).toThrow(
      BadRequestException,
    );
    expect(() => resolveModifierSelection([style], [])).toThrow(
      'Style: choose 1',
    );
  });

  it('rejects too many in a single-select group', () => {
    expect(() =>
      resolveModifierSelection([style, addons], ['o-steamed', 'o-fried']),
    ).toThrow('Style: choose at most 1');
  });

  it('rejects exceeding an optional group max', () => {
    expect(() =>
      resolveModifierSelection(
        [style, addons],
        ['o-steamed', 'o-chutney', 'o-mayo', 'o-cheese'],
      ),
    ).toThrow('Add-ons: choose at most 2');
  });

  it('rejects an unknown / cross-product / inactive option id', () => {
    expect(() =>
      resolveModifierSelection([style, addons], ['o-steamed', 'not-a-real-id']),
    ).toThrow('Unknown or unavailable modifier');
  });

  it('rejects a duplicate selection', () => {
    expect(() =>
      resolveModifierSelection([style, addons], ['o-steamed', 'o-steamed']),
    ).toThrow('more than once');
  });

  it('snapshot follows group then option order, not selection order', () => {
    const r = resolveModifierSelection(
      [style, addons],
      ['o-mayo', 'o-chutney', 'o-fried'],
    );
    expect(r.snapshot.map((s) => s.optionName)).toEqual([
      'Fried',
      'Extra Chutney',
      'Mayo',
    ]);
  });

  it('a required group with no active options is skipped, not impossible', () => {
    const emptyRequired: ModifierGroupDef = {
      id: 'g-empty',
      name: 'Sauce',
      minSelect: 1,
      maxSelect: 1,
      options: [],
    };
    expect(() =>
      resolveModifierSelection([emptyRequired, addons], ['o-chutney']),
    ).not.toThrow();
  });

  it('no groups + no selection is a valid empty result', () => {
    expect(resolveModifierSelection([], [])).toEqual({
      perUnitAdjustMinor: 0,
      snapshot: [],
    });
  });
});
