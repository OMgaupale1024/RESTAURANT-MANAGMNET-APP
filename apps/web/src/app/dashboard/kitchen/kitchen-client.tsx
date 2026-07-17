'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  listActiveOrders,
  updateOrderStatus,
  type OrderSummary,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { connectSocket } from '@/lib/socket';
import { formatMinor } from '@/lib/money';

// The kitchen only cares about live orders. Completed/cancelled/voided drop off.
const ACTIVE = ['PLACED', 'PREPARING', 'READY'];

// What the kitchen does next with an order at each status.
const NEXT: Record<string, { to: string; label: string }> = {
  PLACED: { to: 'PREPARING', label: 'Start' },
  PREPARING: { to: 'READY', label: 'Ready' },
  READY: { to: 'COMPLETED', label: 'Done' },
};

export function KitchenClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);

  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Keep a token ref so the socket handler always refetches with a fresh token
  // without re-subscribing on every silent refresh.
  const tokenRef = useRef(accessToken);
  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  const refetch = useCallback(async () => {
    const token = tokenRef.current;
    if (!token) return;
    try {
      const all = await listActiveOrders(token, onNewToken);
      setOrders(all.filter((o) => ACTIVE.includes(o.status)));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Could not load orders');
    }
  }, [onNewToken]);

  // Initial load.
  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Live updates. A new order or a status change anywhere in this tenant
  // triggers a refetch — simplest correct approach, and the active list is
  // small. The socket only ever carries THIS restaurant's events (server-side
  // per-tenant rooms), so there is nothing to filter here.
  useEffect(() => {
    if (!accessToken) return;
    const socket = connectSocket(accessToken);
    socket.on('connect', () => setLive(true));
    socket.on('disconnect', () => setLive(false));
    socket.on('order.created', () => void refetch());
    socket.on('order.status_changed', () => void refetch());
    return () => {
      socket.close();
    };
    // Reconnect only when the identity itself changes, not on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  async function advance(order: OrderSummary) {
    const next = NEXT[order.status];
    if (!accessToken || !next) return;
    setBusy(order.id);
    setError(null);
    try {
      await updateOrderStatus(accessToken, onNewToken, order.id, next.to);
      // The socket event will refetch, but do it now too so the tap feels
      // instant even if the round trip lags.
      await refetch();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Could not update');
    } finally {
      setBusy(null);
    }
  }

  const columns = [
    { status: 'PLACED', title: 'New' },
    { status: 'PREPARING', title: 'Preparing' },
    { status: 'READY', title: 'Ready' },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Kitchen</h1>
        <span
          className={`flex items-center gap-1.5 text-xs ${live ? 'text-green-700 dark:text-green-300' : 'text-black/50 dark:text-white/50'}`}
        >
          <span
            aria-hidden
            className={`inline-block h-2 w-2 rounded-full ${live ? 'bg-green-500' : 'bg-black/30 dark:bg-white/30'}`}
          />
          {live ? 'Live' : 'Reconnecting…'}
        </span>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {columns.map((col) => {
          const items = orders
            .filter((o) => o.status === col.status)
            .sort((a, b) => a.orderNumber - b.orderNumber);
          return (
            <section
              key={col.status}
              aria-labelledby={`col-${col.status}`}
              className="rounded-lg border border-black/10 p-3 dark:border-white/15"
            >
              <h2
                id={`col-${col.status}`}
                className="flex items-center justify-between text-sm font-medium"
              >
                {col.title}
                <span className="text-xs text-black/50 dark:text-white/50">
                  {items.length}
                </span>
              </h2>

              <ul className="mt-3 space-y-2">
                {items.length === 0 ? (
                  <li className="rounded-md border border-dashed border-black/10 px-3 py-6 text-center text-xs text-black/40 dark:border-white/15 dark:text-white/40">
                    Nothing here
                  </li>
                ) : (
                  items.map((o) => (
                    <li
                      key={o.id}
                      className="rounded-md border border-black/10 p-3 dark:border-white/15"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold tabular-nums">
                          #{o.orderNumber}
                        </span>
                        <span className="text-xs text-black/50 dark:text-white/50">
                          {o._count.items} item{o._count.items === 1 ? '' : 's'} ·{' '}
                          {formatMinor(o.totalMinor)}
                        </span>
                      </div>
                      {NEXT[o.status] && (
                        <button
                          type="button"
                          disabled={busy === o.id}
                          onClick={() => advance(o)}
                          className="mt-2 w-full rounded-md bg-brand px-3 py-2 text-sm font-semibold text-brand-ink hover:brightness-95 disabled:opacity-50"
                        >
                          {busy === o.id ? '…' : NEXT[o.status].label}
                        </button>
                      )}
                    </li>
                  ))
                )}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
