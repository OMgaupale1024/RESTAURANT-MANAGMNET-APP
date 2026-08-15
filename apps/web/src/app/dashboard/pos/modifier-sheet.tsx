'use client';

import { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import type { ModifierGroup, OrderItemModifier, Product } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { cn } from '@/lib/cn';
import { formatMinor } from '@/lib/money';

/**
 * The POS modifier picker. Opens only for products that HAVE modifier groups —
 * plain products keep their one-tap add. Large touch targets, single- vs
 * multi-select driven by each group's max, a live total, and a required-fields
 * guard on the CTA. The server re-validates and re-prices everything; this is
 * only the fast, forgiving front end.
 */

function ruleLabel(g: ModifierGroup): string {
  if (g.maxSelect === 1) return g.minSelect >= 1 ? 'Choose 1' : 'Optional';
  if (g.minSelect >= 1) return `Choose ${g.minSelect}–${g.maxSelect}`;
  return `Choose up to ${g.maxSelect}`;
}

export function ModifierSheet({
  product,
  open,
  onClose,
  onAdd,
}: {
  product: Product | null;
  open: boolean;
  onClose: () => void;
  onAdd: (product: Product, modifiers: OrderItemModifier[]) => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={
        product ? (
          <span className="flex items-baseline justify-between gap-3">
            <span>{product.name}</span>
            <span className="shrink-0 tabular-nums text-ink-2">
              {formatMinor(product.priceMinor)}
            </span>
          </span>
        ) : (
          'Options'
        )
      }
    >
      {/* Keyed by product so each open starts with a clean selection. */}
      {product && (
        <ModifierForm
          key={product.id}
          product={product}
          onAdd={(mods) => {
            onAdd(product, mods);
            onClose();
          }}
        />
      )}
    </Sheet>
  );
}

function ModifierForm({
  product,
  onAdd,
}: {
  product: Product;
  onAdd: (modifiers: OrderItemModifier[]) => void;
}) {
  const [sel, setSel] = useState<Record<string, string[]>>({});

  function toggle(group: ModifierGroup, optionId: string) {
    setSel((prev) => {
      const cur = prev[group.id] ?? [];
      if (group.maxSelect === 1) {
        // Single choice: tapping the selected one clears it only when optional.
        if (cur[0] === optionId) {
          return group.minSelect >= 1 ? prev : { ...prev, [group.id]: [] };
        }
        return { ...prev, [group.id]: [optionId] };
      }
      if (cur.includes(optionId)) {
        return { ...prev, [group.id]: cur.filter((x) => x !== optionId) };
      }
      if (cur.length >= group.maxSelect) return prev; // at the cap — ignore
      return { ...prev, [group.id]: [...cur, optionId] };
    });
  }

  const { snapshot, adjust } = useMemo(() => {
    const snap: OrderItemModifier[] = [];
    for (const g of product.modifierGroups) {
      for (const o of g.options) {
        if ((sel[g.id] ?? []).includes(o.id)) {
          snap.push({
            optionId: o.id,
            groupName: g.name,
            optionName: o.name,
            priceAdjustMinor: o.priceAdjustMinor,
          });
        }
      }
    }
    return { snapshot: snap, adjust: snap.reduce((s, e) => s + e.priceAdjustMinor, 0) };
  }, [sel, product]);

  const requiredOk = product.modifierGroups.every(
    (g) => (sel[g.id]?.length ?? 0) >= g.minSelect,
  );
  const total = product.priceMinor + adjust;

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 space-y-5">
        {product.modifierGroups.map((g) => {
          const chosen = sel[g.id] ?? [];
          const required = g.minSelect >= 1;
          const unmet = required && chosen.length < g.minSelect;
          return (
            <fieldset key={g.id}>
              <legend className="mb-2 flex w-full items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold">
                  {g.name}
                  {required && <span className="ml-0.5 text-danger-text">*</span>}
                </span>
                <span
                  className={cn(
                    'text-[12px]',
                    unmet ? 'text-danger-text' : 'text-ink-3',
                  )}
                >
                  {ruleLabel(g)}
                </span>
              </legend>
              <div className="grid grid-cols-2 gap-2">
                {g.options.map((o) => {
                  const on = chosen.includes(o.id);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggle(g, o.id)}
                      className={cn(
                        'flex min-h-12 items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-[13px] transition-colors duration-120',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current',
                        on
                          ? 'border-brand bg-brand/10 font-medium text-ink'
                          : 'border-line text-ink-2 hover:border-line-2 hover:text-ink',
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        {on && <Check aria-hidden className="size-4 shrink-0 text-brand-text" />}
                        <span className="truncate">{o.name}</span>
                      </span>
                      {o.priceAdjustMinor > 0 && (
                        <span className="shrink-0 tabular-nums text-ink-3">
                          +{formatMinor(o.priceAdjustMinor)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </div>

      {/* Pinned CTA — the one obvious action, always in reach. */}
      <div className="sticky bottom-0 -mx-6 mt-6 border-t border-line bg-surface px-6 pt-4 pb-1">
        <Button
          variant="primary"
          size="lg"
          disabled={!requiredOk}
          onClick={() => onAdd(snapshot)}
          className="w-full"
        >
          {requiredOk ? `Add to Order ${formatMinor(total)}` : 'Choose required options'}
        </Button>
      </div>
    </div>
  );
}
