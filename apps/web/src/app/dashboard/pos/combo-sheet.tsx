'use client';

import { Check, Gift } from 'lucide-react';
import type { Combo } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { formatMinor } from '@/lib/money';

/**
 * Combo confirmation: shows what's inside and one price, then adds the whole
 * bundle as a single cart line. No per-component configuration in v1 — a combo
 * is a fast, fixed selection. The server re-prices and re-validates on checkout.
 */
export function ComboSheet({
  combo,
  open,
  onClose,
  onAdd,
}: {
  combo: Combo | null;
  open: boolean;
  onClose: () => void;
  onAdd: (combo: Combo) => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={
        combo ? (
          <span className="flex items-baseline justify-between gap-3">
            <span className="flex items-center gap-1.5">
              <Gift aria-hidden className="size-4 text-ink-2" />
              {combo.name}
            </span>
            <span className="shrink-0 tabular-nums text-ink-2">
              {formatMinor(combo.priceMinor)}
            </span>
          </span>
        ) : (
          'Combo'
        )
      }
    >
      {combo && (
        <div className="flex min-h-full flex-col">
          <div className="flex-1">
            {combo.description && (
              <p className="mb-3 text-[13px] text-ink-2">{combo.description}</p>
            )}
            <p className="text-label mb-2">Includes</p>
            <ul className="space-y-1.5">
              {combo.items.map((ci) => (
                <li
                  key={ci.productId}
                  className="flex items-center gap-2 text-[14px]"
                >
                  <Check aria-hidden className="size-4 shrink-0 text-success-text" />
                  <span className="tabular-nums text-ink-2">{ci.quantity} ×</span>
                  <span className="min-w-0 truncate">{ci.product.name}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="sticky bottom-0 -mx-6 mt-6 border-t border-line bg-surface px-6 pt-4 pb-1">
            <Button
              variant="primary"
              size="lg"
              disabled={!combo.available}
              onClick={() => onAdd(combo)}
              className="w-full"
            >
              {combo.available
                ? `Add to Order ${formatMinor(combo.priceMinor)}`
                : 'Unavailable — an item is out'}
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
