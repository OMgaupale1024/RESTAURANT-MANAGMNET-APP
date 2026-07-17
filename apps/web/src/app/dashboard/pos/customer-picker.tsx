'use client';

import { useState } from 'react';
import { ApiRequestError, findCustomerByPhone } from '@/lib/api';

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
      <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-black/10 px-3 py-2 text-sm dark:border-white/15">
        <span className="truncate">{customer.name}</span>
        <button
          type="button"
          onClick={() => setCustomer(null)}
          className="text-xs text-black/60 underline dark:text-white/60"
        >
          Remove
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <label htmlFor="cust-phone" className="block text-xs font-medium">
        Customer phone{' '}
        <span className="text-black/50 dark:text-white/50">(optional)</span>
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id="cust-phone"
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
          placeholder="9876543210"
          className="min-w-0 flex-1 rounded-md border border-black/20 bg-transparent px-3 py-2 text-sm dark:border-white/25"
        />
        <button
          type="button"
          onClick={() => void lookup()}
          disabled={busy}
          className="rounded-md border border-black/20 px-3 py-2 text-xs font-medium disabled:opacity-50 dark:border-white/25"
        >
          Find
        </button>
      </div>
      {missed && (
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">
          Not found — the order will be anonymous.
        </p>
      )}
    </div>
  );
}
