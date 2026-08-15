import { BadRequestException } from '@nestjs/common';

/**
 * Order-time combo pricing, kept pure and tested. A combo is sold as ONE line
 * at its OWN price — never the component sum — so the customer is billed the
 * combo price and analytics count it once. The components are snapshotted for
 * the kitchen/history and expanded into real product lines for inventory
 * depletion (which the existing recipe consumption then handles).
 *
 * The caller loads only ACTIVE combos; this still re-checks each component is
 * active, so a combo with a since-deactivated item is refused at checkout
 * rather than silently selling an invalid bundle.
 */

export type ComboComponent = {
  productId: string;
  quantity: number;
  product: { name: string; isActive: boolean };
};

export type ComboDef = {
  name: string;
  priceMinor: number;
  taxRateBp: number;
  items: ComboComponent[];
};

export type ComboItemSnapshot = {
  productId: string;
  name: string;
  quantity: number;
};

export function buildComboLine(
  combo: ComboDef,
  quantity: number,
): {
  nameSnapshot: string;
  unitPriceMinor: number;
  taxRateBp: number;
  comboItems: ComboItemSnapshot[];
  depletion: Array<{ productId: string; quantity: number }>;
} {
  if (combo.items.length === 0) {
    throw new BadRequestException(`${combo.name} has no items`);
  }
  const inactive = combo.items.find((i) => !i.product.isActive);
  if (inactive) {
    // Mirrors the message the POS shows on an unavailable combo.
    throw new BadRequestException(`${combo.name} contains an unavailable item`);
  }

  const comboItems: ComboItemSnapshot[] = combo.items.map((i) => ({
    productId: i.productId,
    name: i.product.name,
    quantity: i.quantity,
  }));

  // One deplete entry per component, scaled by how many combos were ordered.
  const depletion = combo.items.map((i) => ({
    productId: i.productId,
    quantity: i.quantity * quantity,
  }));

  return {
    nameSnapshot: combo.name,
    unitPriceMinor: combo.priceMinor,
    taxRateBp: combo.taxRateBp,
    comboItems,
    depletion,
  };
}
