'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiRequestError,
  createCustomer,
  getCustomer,
  listCustomers,
  type CustomerDetail,
  type CustomerSummary,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatMinor } from '@/lib/money';

export function CustomersClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback(
    (t: string) => setAccessToken(t),
    [setAccessToken],
  );

  const [rows, setRows] = useState<CustomerSummary[]>([]);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    // Debounced: a keystroke per request would hammer the API and the search
    // is not urgent.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const list = await listCustomers(
            accessToken,
            onNewToken,
            q.trim() || undefined,
          );
          if (!cancelled) setRows(list);
        } catch (e) {
          if (!cancelled) {
            setError(
              e instanceof ApiRequestError ? e.message : 'Could not load customers',
            );
          }
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [accessToken, onNewToken, q, reloadKey]);

  async function open(id: string) {
    if (!accessToken) return;
    setError(null);
    try {
      setSelected(await getCustomer(accessToken, onNewToken, id));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Could not open');
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Customers</h1>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section aria-labelledby="cust-list">
          <h2 id="cust-list" className="sr-only">
            Customer list
          </h2>

          <label htmlFor="cust-search" className="block text-sm font-medium">
            Search
          </label>
          <input
            id="cust-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name or phone"
            className="mt-1 mb-3 w-full rounded-md border border-black/20 bg-transparent px-3 py-2 text-sm dark:border-white/25"
          />

          {rows.length === 0 ? (
            <div className="rounded-lg border border-black/10 p-6 dark:border-white/15">
              <p className="text-sm text-black/70 dark:text-white/70">
                {q ? 'No matches.' : 'No customers yet.'}
              </p>
              <AddCustomer
                accessToken={accessToken}
                onNewToken={onNewToken}
                onAdded={reload}
                setError={setError}
              />
            </div>
          ) : (
            <>
              <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/15 dark:border-white/15">
                {rows.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => open(c.id)}
                      className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10 ${
                        selected?.id === c.id ? 'bg-black/5 dark:bg-white/10' : ''
                      }`}
                    >
                      <span className="font-medium">{c.name}</span>
                      <span className="text-black/60 tabular-nums dark:text-white/60">
                        {c.phone}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <details className="mt-4">
                <summary className="cursor-pointer text-sm text-black/60 dark:text-white/60">
                  Add a customer
                </summary>
                <AddCustomer
                  accessToken={accessToken}
                  onNewToken={onNewToken}
                  onAdded={reload}
                  setError={setError}
                />
              </details>
            </>
          )}
        </section>

        <section
          aria-labelledby="cust-detail"
          className="rounded-lg border border-black/10 p-4 dark:border-white/15"
        >
          <h2 id="cust-detail" className="text-sm font-medium">
            {selected ? selected.name : 'Customer'}
          </h2>

          {!selected ? (
            <p className="mt-3 text-sm text-black/60 dark:text-white/60">
              Select a customer.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-black/60 tabular-nums dark:text-white/60">
                {selected.phone}
                {selected.email ? ` · ${selected.email}` : ''}
              </p>

              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <Stat label="Visits" value={String(selected.stats.visits)} />
                <Stat
                  label="Total spent"
                  value={formatMinor(selected.stats.totalSpentMinor)}
                />
                <Stat
                  label="Average bill"
                  value={formatMinor(selected.stats.averageBillMinor)}
                />
                <Stat
                  label="Last visit"
                  value={
                    selected.stats.lastVisit
                      ? new Date(selected.stats.lastVisit).toLocaleDateString()
                      : '—'
                  }
                />
              </dl>

              <h3 className="mt-6 text-xs font-medium text-black/60 dark:text-white/60">
                Recent orders
              </h3>
              {selected.recentOrders.length === 0 ? (
                <p className="mt-2 text-xs text-black/50 dark:text-white/50">
                  No orders yet.
                </p>
              ) : (
                <ul className="mt-2 space-y-1 text-xs">
                  {selected.recentOrders.map((o) => (
                    <li key={o.id} className="flex justify-between gap-2">
                      <span>#{o.orderNumber}</span>
                      {/* Voided orders stay visible but are not counted as
                          spend — the history is honest either way. */}
                      <span className="text-black/50 dark:text-white/50">
                        {o.status.toLowerCase()}
                      </span>
                      <span className="tabular-nums">
                        {formatMinor(o.totalMinor)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-black/60 dark:text-white/60">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function AddCustomer({
  accessToken,
  onNewToken,
  onAdded,
  setError,
}: {
  accessToken: string | null;
  onNewToken: (t: string) => void;
  onAdded: () => void;
  setError: (m: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  // Mirrors the server rule (7-15 digits). The server re-validates regardless.
  const digits = phone.replace(/\D/g, '');
  const valid = name.trim().length > 0 && digits.length >= 7 && digits.length <= 15;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !valid) return;
    setBusy(true);
    setError(null);
    try {
      await createCustomer(accessToken, onNewToken, {
        name: name.trim(),
        phone: digits,
      });
      setName('');
      setPhone('');
      onAdded();
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : 'Could not add customer',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
      <div className="flex-1">
        <label htmlFor="c-name" className="block text-xs font-medium">
          Name
        </label>
        <input
          id="c-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          className="mt-1 w-full rounded-md border border-black/20 bg-transparent px-3 py-2 text-sm dark:border-white/25"
        />
      </div>
      <div className="w-40">
        <label htmlFor="c-phone" className="block text-xs font-medium">
          Phone
        </label>
        <input
          id="c-phone"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="9876543210"
          className="mt-1 w-full rounded-md border border-black/20 bg-transparent px-3 py-2 text-sm dark:border-white/25"
        />
      </div>
      <button
        type="submit"
        disabled={!valid || busy}
        className="rounded-md border border-black/20 px-3 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/25"
      >
        Add
      </button>
    </form>
  );
}
