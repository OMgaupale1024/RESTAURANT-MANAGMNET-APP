'use client';

import { useState } from 'react';
import { UserRound, UserRoundPlus, X } from 'lucide-react';
import type { CustomerSegment } from '@/lib/api';
import { formatMinor } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { SegmentChip } from '@/components/ui/segment-chip';
import { CustomerDialog } from './customer-dialog';

/**
 * A customer attached to the order in progress. Carries the preview signals
 * (segment, visits, spend) captured at the moment of attach, so the cart chip
 * shows them without a second request. There is no loyalty tier/points — no
 * such program exists yet.
 */
export type PosCustomer = {
  id: string;
  name: string;
  phone: string;
  segment: CustomerSegment | null;
  visits: number;
  totalSpentMinor: number;
};

/**
 * The optional customer affordance in the cart: a chip when one is attached, an
 * "Add customer" button (opening the lookup dialog) when none is. Guest
 * checkout needs no interaction at all — this is never in the way of a sale.
 */
export function CustomerPicker({
  accessToken,
  onNewToken,
  customer,
  setCustomer,
  setError,
}: {
  accessToken: string | null;
  onNewToken: (t: string) => void;
  customer: PosCustomer | null;
  setCustomer: (c: PosCustomer | null) => void;
  setError: (m: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  if (customer) {
    return (
      <div className="mt-3 flex animate-fade-up items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
        <UserRound aria-hidden className="size-4 shrink-0 text-ink-3" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] font-medium">
              {customer.name}
            </span>
            {customer.segment && <SegmentChip segment={customer.segment} />}
          </div>
          <p className="truncate text-[11px] text-ink-3 tabular-nums">
            {customer.phone}
            {customer.visits > 0 &&
              ` · ${customer.visits} visit${customer.visits === 1 ? '' : 's'} · ${formatMinor(customer.totalSpentMinor)}`}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Remove customer"
          onClick={() => setCustomer(null)}
          className="w-7 shrink-0 px-0 text-ink-3"
        >
          <X aria-hidden className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        className="h-8 w-full justify-center text-[12px]"
      >
        <UserRoundPlus aria-hidden className="size-4" />
        Add customer (optional)
      </Button>
      <CustomerDialog
        open={open}
        onClose={() => setOpen(false)}
        accessToken={accessToken}
        onNewToken={onNewToken}
        onAttach={(c) => {
          setCustomer(c);
          setOpen(false);
        }}
        onError={(m) => setError(m)}
      />
    </div>
  );
}
