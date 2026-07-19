'use client';

import { useState } from 'react';
import { UserRound, X } from 'lucide-react';
import { ApiRequestError, findCustomerByPhone } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Optional customer lookup by phone, at the till.
 *
 * Deliberately lookup-only: creating a customer mid-sale is a distraction at a
 * busy counter, and the Customers screen already does it properly. An unknown
 * number is not an error — the order simply stays anonymous, which is the
 * honest default for a restaurant.
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
  customer: { id: string; name: string } | null;
  setCustomer: (c: { id: string; name: string } | null) => void;
  setError: (m: string | null) => void;
}) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [missed, setMissed] = useState(false);

  async function lookup() {
    if (!accessToken) return;
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7) return;

    setBusy(true);
    setMissed(false);
    setError(null);
    try {
      const found = await findCustomerByPhone(accessToken, onNewToken, digits);
      if (found && 'id' in found) {
        setCustomer({ id: found.id, name: found.name });
        setPhone('');
      } else {
        setMissed(true);
      }
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Lookup failed');
    } finally {
      setBusy(false);
    }
  }

  if (customer) {
    return (
      <div className="mt-3 flex animate-fade-up items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
        <UserRound aria-hidden className="size-4 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{customer.name}</span>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Remove customer"
          onClick={() => setCustomer(null)}
          className="w-7 px-0 text-ink-3"
        >
          <X aria-hidden className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <div className="flex gap-2">
        <Input
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => {
            // Enter would submit nothing here; make it do the useful thing.
            if (e.key === 'Enter') {
              e.preventDefault();
              void lookup();
            }
          }}
          placeholder="Customer phone (optional)"
          aria-label="Customer phone"
          className="h-8 min-w-0 flex-1 text-[12px]"
        />
        <Button variant="secondary" size="sm" onClick={() => void lookup()} disabled={busy} className="h-8">
          Find
        </Button>
      </div>
      {missed && (
        <p className="mt-1 text-[11px] text-ink-3">
          Not found — the order will be anonymous.
        </p>
      )}
    </div>
  );
}
