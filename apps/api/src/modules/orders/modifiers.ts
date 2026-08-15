import { BadRequestException } from '@nestjs/common';

/**
 * Modifier pricing + selection validation, kept pure so it is trivially
 * testable and so the money math has one home. The server ALWAYS runs this —
 * the client sends only option ids, never prices or amounts.
 *
 * The caller passes the product's ACTIVE groups (each with its ACTIVE options);
 * inactive groups/options are simply absent, so they can neither be required
 * nor selected. The returned adjustment is per unit and is baked into the order
 * line's unit price by the caller, which keeps line_total = unit_price * qty
 * (the DB CHECK) true and lets analytics reconcile with no special-casing.
 */

export type ModifierOptionDef = {
  id: string;
  name: string;
  priceAdjustMinor: number;
};

export type ModifierGroupDef = {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: ModifierOptionDef[];
};

/** What lands on order_items.modifiers — a self-contained snapshot. */
export type ModifierSnapshotEntry = {
  optionId: string;
  groupName: string;
  optionName: string;
  priceAdjustMinor: number;
};

export function resolveModifierSelection(
  groups: ModifierGroupDef[],
  selectedOptionIds: readonly string[],
): { perUnitAdjustMinor: number; snapshot: ModifierSnapshotEntry[] } {
  // A repeated id is a malformed request, not "chose it twice".
  if (new Set(selectedOptionIds).size !== selectedOptionIds.length) {
    throw new BadRequestException('A modifier was selected more than once');
  }

  // optionId -> its option + owning group. Only active groups/options are here,
  // so anything not found is either inactive, unknown, or another product's.
  const byOption = new Map<
    string,
    { group: ModifierGroupDef; option: ModifierOptionDef }
  >();
  for (const group of groups) {
    for (const option of group.options) {
      byOption.set(option.id, { group, option });
    }
  }

  const selectedSet = new Set(selectedOptionIds);
  for (const id of selectedSet) {
    if (!byOption.has(id)) {
      throw new BadRequestException('Unknown or unavailable modifier selected');
    }
  }

  // Enforce each group's min/max against how many of ITS options were chosen.
  // A group whose options are all inactive (none offered) cannot be required —
  // skip it rather than making the product impossible to order.
  for (const group of groups) {
    if (group.options.length === 0) continue;
    const chosen = group.options.filter((o) => selectedSet.has(o.id)).length;
    if (chosen < group.minSelect) {
      throw new BadRequestException(
        group.minSelect === 1 && group.maxSelect === 1
          ? `${group.name}: choose 1`
          : `${group.name}: choose at least ${group.minSelect}`,
      );
    }
    if (chosen > group.maxSelect) {
      throw new BadRequestException(
        `${group.name}: choose at most ${group.maxSelect}`,
      );
    }
  }

  // Snapshot in a stable order: group order, then option order within a group,
  // so a receipt reads the same way every time regardless of selection order.
  const snapshot: ModifierSnapshotEntry[] = [];
  for (const group of groups) {
    for (const option of group.options) {
      if (!selectedSet.has(option.id)) continue;
      snapshot.push({
        optionId: option.id,
        groupName: group.name,
        optionName: option.name,
        priceAdjustMinor: option.priceAdjustMinor,
      });
    }
  }

  const perUnitAdjustMinor = snapshot.reduce(
    (s, e) => s + e.priceAdjustMinor,
    0,
  );
  return { perUnitAdjustMinor, snapshot };
}
