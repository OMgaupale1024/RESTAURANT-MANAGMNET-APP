import { BadRequestException } from '@nestjs/common';
import { buildComboLine, type ComboDef } from './combos';

const combo: ComboDef = {
  name: 'Veg Momos Combo',
  priceMinor: 8500,
  taxRateBp: 500,
  items: [
    { productId: 'p-momo', quantity: 1, product: { name: 'Veg Momos', isActive: true } },
    { productId: 'p-coke', quantity: 1, product: { name: 'Cold Drink', isActive: true } },
  ],
};

describe('buildComboLine', () => {
  it('prices at the combo price, not the component sum', () => {
    const line = buildComboLine(combo, 2);
    expect(line.unitPriceMinor).toBe(8500); // the combo's own price
    expect(line.nameSnapshot).toBe('Veg Momos Combo');
    expect(line.taxRateBp).toBe(500);
  });

  it('snapshots the components for the kitchen and history', () => {
    const line = buildComboLine(combo, 1);
    expect(line.comboItems).toEqual([
      { productId: 'p-momo', name: 'Veg Momos', quantity: 1 },
      { productId: 'p-coke', name: 'Cold Drink', quantity: 1 },
    ]);
  });

  it('expands components (scaled by combo quantity) for inventory depletion', () => {
    const platter: ComboDef = {
      name: 'Platter',
      priceMinor: 19900,
      taxRateBp: 500,
      items: [
        { productId: 'p-momo', quantity: 3, product: { name: 'Veg Momos', isActive: true } },
        { productId: 'p-pan', quantity: 2, product: { name: 'Paneer Momos', isActive: true } },
      ],
    };
    expect(buildComboLine(platter, 2).depletion).toEqual([
      { productId: 'p-momo', quantity: 6 },
      { productId: 'p-pan', quantity: 4 },
    ]);
  });

  it('refuses a combo whose component is deactivated', () => {
    const broken: ComboDef = {
      ...combo,
      items: [
        combo.items[0],
        { productId: 'p-coke', quantity: 1, product: { name: 'Cold Drink', isActive: false } },
      ],
    };
    expect(() => buildComboLine(broken, 1)).toThrow(BadRequestException);
    expect(() => buildComboLine(broken, 1)).toThrow('contains an unavailable item');
  });

  it('refuses an empty combo', () => {
    expect(() => buildComboLine({ ...combo, items: [] }, 1)).toThrow('has no items');
  });
});
