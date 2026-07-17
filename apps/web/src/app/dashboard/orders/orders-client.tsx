'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiRequestError,
  getOrder,
  getTimeline,
  listOrders,
  updateOrderStatus,
  type Order,
  type OrderSummary,
  type TimelineEvent,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatMinor } from '@/lib/money';
import { nextStatuses } from '@/lib/order-status';

const FILTERS = ['ALL', 'PLACED', 'PREPARING', 'READY', 'COMPLETED'] as const;

export function OrdersClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback(
    (t: string) => setAccessToken(t),
    [setAccessToken],
  );

  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL');
  const [selected, setSelected] = useState<Order | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listOrders(
          accessToken,
          onNewToken,
          filter === 'ALL' ? undefined : filter,
        );
        if (!cancelled) setOrders(rows);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof ApiRequestError ? e.message : 'Could not load orders',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, filter, reloadKey]);

  async function open(id: string) {
    if (!accessToken) return;
    setError(null);
    try {
      const [order, events] = await Promise.all([
        getOrder(accessToken, onNewToken, id),
        getTimeline(accessToken, onNewToken, id),
      ]);
      setSelected(order);
      setTimeline(events);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Could not open order');
    }
  }

  async function move(status: string) {
    if (!accessToken || !selected) return;
    // A void reverses money, so make the reason explicit rather than silent.
    const reason =
      status === 'VOIDED' || status === 'CANCELLED'
        ? (globalThis.prompt(`Reason for ${status.toLowerCase()}:`) ?? undefined)
        : undefined;
    if ((status === 'VOIDED' || status === 'CANCELLED') && !reason) return;

    setBusy(true);
    setError(null);
    try {
      await updateOrderStatus(
        accessToken,
        onNewToken,
        selected.id,
        status,
        reason,
      );
      await open(selected.id);
      reload();
    } catch (e) {
      // A 403 here is the server refusing a void to someone without
      // order.void — surfaced verbatim rather than hidden.
      setError(e instanceof ApiRequestError ? e.message : 'Could not update');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Orders</h1>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={`rounded-md px-3 py-1.5 text-sm focus-visible:outline-2 ${
              filter === f
                ? 'bg-black/10 font-medium dark:bg-white/15'
                : 'hover:bg-black/5 dark:hover:bg-white/10'
            }`}
          >
            {f === 'ALL' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section aria-labelledby="list-heading">
          <h2 id="list-heading" className="sr-only">
            Order list
          </h2>
          {orders.length === 0 ? (
            <p className="rounded-lg border border-black/10 p-6 text-sm text-black/60 dark:border-white/15 dark:text-white/60">
              No orders{filter === 'ALL' ? ' yet' : ` with status ${filter}`}.
            </p>
          ) : (
            <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/15 dark:border-white/15">
              {orders.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => open(o.id)}
                    aria-current={selected?.id === o.id ? 'true' : undefined}
                    className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm focus-visible:outline-2 hover:bg-black/5 dark:hover:bg-white/10 ${
                      selected?.id === o.id ? 'bg-black/5 dark:bg-white/10' : ''
                    }`}
                  >
                    <span className="font-medium tabular-nums">
                      #{o.orderNumber}
                    </span>
                    <StatusBadge status={o.status} />
                    <span className="text-black/60 dark:text-white/60">
                      {o._count.items} item{o._count.items === 1 ? '' : 's'}
                    </span>
                    <span className="ml-auto tabular-nums">
                      {formatMinor(o.totalMinor)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section
          aria-labelledby="detail-heading"
          className="rounded-lg border border-black/10 p-4 dark:border-white/15"
        >
          <h2 id="detail-heading" className="text-sm font-medium">
            {selected ? `Order #${selected.orderNumber}` : 'Order detail'}
          </h2>

          {!selected ? (
            <p className="mt-3 text-sm text-black/60 dark:text-white/60">
              Select an order to see it.
            </p>
          ) : (
            <>
              <div className="mt-3">
                <StatusBadge status={selected.status} />
              </div>

              <ul className="mt-4 space-y-1 text-sm">
                {selected.items.map((i) => (
                  <li key={i.id} className="flex justify-between gap-2">
                    <span className="truncate">
                      {i.quantity} × {i.nameSnapshot}
                    </span>
                    <span className="tabular-nums">
                      {formatMinor(i.lineTotalMinor)}
                    </span>
                  </li>
                ))}
              </ul>

              <dl className="mt-3 space-y-1 border-t border-black/10 pt-3 text-sm dark:border-white/15">
                <div className="flex justify-between">
                  <dt className="text-black/60 dark:text-white/60">Tax</dt>
                  <dd className="tabular-nums">{formatMinor(selected.taxMinor)}</dd>
                </div>
                <div className="flex justify-between font-semibold">
                  <dt>Total</dt>
                  <dd className="tabular-nums">
                    {formatMinor(selected.totalMinor)}
                  </dd>
                </div>
              </dl>

              {nextStatuses(selected.status).length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {nextStatuses(selected.status).map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={busy}
                      onClick={() => move(s)}
                      className={`rounded-md px-3 py-2 text-xs font-semibold focus-visible:outline-2 disabled:opacity-50 ${
                        s === 'VOIDED' || s === 'CANCELLED'
                          ? 'border border-red-500/40 text-red-700 hover:bg-red-500/10 dark:text-red-300'
                          : 'bg-brand text-brand-ink hover:brightness-95'
                      }`}
                    >
                      {s.charAt(0) + s.slice(1).toLowerCase()}
                    </button>
                  ))}
                </div>
              )}

              <h3 className="mt-6 text-xs font-medium text-black/60 dark:text-white/60">
                Timeline
              </h3>
              <ol className="mt-2 space-y-2 text-xs">
                {timeline.map((e) => (
                  <li key={e.id} className="flex gap-2">
                    <span className="text-black/40 tabular-nums dark:text-white/40">
                      {new Date(e.createdAt).toLocaleTimeString()}
                    </span>
                    <span>
                      {e.type === 'CREATED'
                        ? 'Placed'
                        : `${e.fromStatus} → ${e.toStatus}`}
                      {typeof e.metadata?.reason === 'string' && (
                        <span className="text-black/60 dark:text-white/60">
                          {' '}
                          · {e.metadata.reason}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  // Colour carries meaning, but never alone — the label is always present, so
  // this stays readable without colour perception.
  const tone =
    status === 'COMPLETED'
      ? 'bg-green-600/15 text-green-800 dark:text-green-300'
      : status === 'VOIDED' || status === 'CANCELLED'
        ? 'bg-red-500/15 text-red-700 dark:text-red-300'
        : 'bg-black/10 text-black/70 dark:bg-white/15 dark:text-white/70';
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${tone}`}>
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}
