'use client';

import { Plus, X } from 'lucide-react';
import type { UpsellRule } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { formatMinor } from '@/lib/money';

/**
 * One gentle suggestion after a trigger product is added — a dismissible banner
 * pinned above the till, never a modal and never more than one at a time, so it
 * never interrupts checkout. The suggested product is added at its own price.
 */
export function UpsellBanner({
  rule,
  onAccept,
  onDismiss,
}: {
  rule: UpsellRule | null;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  if (!rule) return null;
  return (
    <div
      role="status"
      className="animate-fade-up fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md rounded-xl border border-line bg-surface p-3 shadow-[0_8px_24px_rgb(0_0_0/0.12)] sm:inset-x-auto sm:right-6 sm:left-auto"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] text-ink-3">Complete the order?</p>
          <p className="truncate text-[14px] font-medium">
            Add {rule.suggestedProduct.name}
            <span className="ml-1.5 tabular-nums text-ink-2">
              {formatMinor(rule.suggestedProduct.priceMinor)}
            </span>
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={onAccept} className="shrink-0">
          <Plus aria-hidden className="size-3.5" />
          Add
        </Button>
        <button
          type="button"
          aria-label="No thanks"
          onClick={onDismiss}
          className="shrink-0 rounded-lg p-1.5 text-ink-3 transition-colors duration-120 hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>
    </div>
  );
}
