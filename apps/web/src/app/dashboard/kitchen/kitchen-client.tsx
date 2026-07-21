'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { BellRing, CheckCircle2, ChefHat, Receipt, UserRound, type LucideIcon } from 'lucide-react';
import {
  ApiRequestError,
  getOrder,
  getRestaurantProfile,
  getTimeline,
  listActiveOrders,
  updateOrderStatus,
  type Order,
  type OrderSummary,
  type RestaurantProfile,
  type TimelineEvent,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { connectSocket } from '@/lib/socket';
import {
  DANGER_STATUSES,
  OrderDetail,
  QUICK,
  StatusBadge,
  timeShort,
  TYPE_LABEL,
} from '../orders/order-detail';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/modal';
import { EmptyState } from '@/components/ui/empty-state';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';

/**
 * Kitchen Display System — a kanban board over the order state machine,
 * always dark (a wall screen, DESIGN.md §6), live over the existing
 * per-tenant socket. Events PATCH local state — only the affected ticket
 * re-renders; the screen never reloads.
 */

const COLUMNS: Array<{ status: string; title: string; icon: LucideIcon; empty: string }> = [
  { status: 'PLACED', title: 'New', icon: Receipt, empty: 'New orders from the till land here instantly.' },
  { status: 'PREPARING', title: 'Preparing', icon: ChefHat, empty: 'Tap Start on a new ticket to begin cooking.' },
  { status: 'READY', title: 'Ready', icon: BellRing, empty: 'Tap Ready when a ticket is plated for pickup.' },
];
const BOARD_STATUSES = COLUMNS.map((c) => c.status);

/** Elapsed-time escalation (DESIGN.md §6): calm → warning 10m → critical 20m. */
const WARN_MS = 10 * 60_000;
const CRIT_MS = 20 * 60_000;

/** How many recently completed tickets the collapsible strip keeps. */
const DONE_SHOWN = 10;
/** State cap so a screen left open for days cannot grow without bound. */
const MAX_ORDERS = 150;

/** The board stores list-shaped rows; live inserts arrive detail-shaped. */
function toSummary(o: Order): OrderSummary {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    orderType: o.orderType,
    totalMinor: o.totalMinor,
    createdAt: o.createdAt,
    placedAt: o.placedAt,
    notes: o.notes,
    _count: { items: o.items.length },
    customer: o.customer ? { name: o.customer.name } : null,
    payments: o.payments.map((p) => ({ method: p.method, status: p.status })),
    items: o.items.map((i) => ({
      nameSnapshot: i.nameSnapshot,
      quantity: i.quantity,
      notes: i.notes,
    })),
  };
}

export function KitchenClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [live, setLive] = useState(false);
  // Ticket id → arrival timestamp for socket-driven inserts/moves: those get
  // the slide-in + flash entrance; the initial load gets a quiet fade-up.
  const [arrivals, setArrivals] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ order: Order; timeline: TimelineEvent[] } | null>(null);
  const [askDanger, setAskDanger] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [profile, setProfile] = useState<RestaurantProfile | null>(null);

  // For the KOT header; a failure only means the ticket prints without it.
  useEffect(() => {
    if (!accessToken) return;
    getRestaurantProfile(accessToken, onNewToken)
      .then(setProfile)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const tokenRef = useRef(accessToken);
  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);
  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const refetchAll = useCallback(async () => {
    const token = tokenRef.current;
    if (!token) return;
    try {
      setOrders(await listActiveOrders(token, onNewToken));
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not load orders',
        variant: 'danger',
      });
    }
  }, [onNewToken, toast]);

  useEffect(() => {
    void refetchAll();
  }, [refetchAll]);

  /** Insert-or-replace one ticket, newest first, capped. */
  const upsert = useCallback((row: OrderSummary) => {
    setOrders((prev) =>
      prev === null ? prev : [row, ...prev.filter((x) => x.id !== row.id)].slice(0, MAX_ORDERS),
    );
    setArrivals((a) => ({ ...a, [row.id]: Date.now() }));
  }, []);

  /** Fetch one order and place it on the board (created / unknown-id events). */
  const fetchAndUpsert = useCallback(
    (id: string) => {
      const token = tokenRef.current;
      if (!token) return;
      getOrder(token, onNewToken, id)
        .then((o) => upsert(toSummary(o)))
        .catch(() => {
          // A ticket we cannot fetch stays off the board; the next resync
          // (reconnect) will reconcile.
        });
    },
    [onNewToken, upsert],
  );

  const loadDetail = useCallback(
    (id: string): Promise<void> => {
      const token = tokenRef.current;
      if (!token) return Promise.resolve();
      return Promise.all([getOrder(token, onNewToken, id), getTimeline(token, onNewToken, id)])
        .then(([order, timeline]) => {
          setSelectedId(id);
          setDetail({ order, timeline });
        })
        .catch((e: unknown) => {
          setSelectedId(null);
          toast({
            title: e instanceof ApiRequestError ? e.message : 'Could not open order',
            variant: 'danger',
          });
        });
    },
    [onNewToken, toast],
  );

  // Live board. Events patch exactly one ticket (backlog #28's upgrade path):
  // created fetches the one new order; status_changed rewrites one row's
  // status in place. Reconnect resyncs the whole list to cover missed events.
  useEffect(() => {
    if (!accessToken) return;
    const socket = connectSocket(accessToken);
    socket.on('connect', () => {
      setLive(true);
      void refetchAll();
    });
    socket.on('disconnect', () => setLive(false));
    socket.on('order.created', (p: { id: string }) => fetchAndUpsert(p.id));
    socket.on('order.status_changed', (p: { id: string; status: string }) => {
      setOrders((prev) => {
        if (prev === null) return prev;
        if (!prev.some((x) => x.id === p.id)) {
          // Not on the board (older than the fetch window): pull it in only
          // if it now needs cooking.
          if (BOARD_STATUSES.includes(p.status)) fetchAndUpsert(p.id);
          return prev;
        }
        return prev.map((x) => (x.id === p.id ? { ...x, status: p.status } : x));
      });
      setArrivals((a) => ({ ...a, [p.id]: Date.now() }));
      if (selectedIdRef.current === p.id) void loadDetail(p.id);
    });
    return () => {
      socket.close();
    };
    // Reconnect only when the identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const advance = useCallback(
    async (id: string, to: string, reason?: string) => {
      const token = tokenRef.current;
      if (!token) return;
      setBusy(id);
      setMoving(true);
      try {
        await updateOrderStatus(token, onNewToken, id, to, reason);
        // The socket echo patches the board too; patching now makes the tap
        // feel instant even if the round trip lags.
        setOrders((prev) =>
          prev === null ? prev : prev.map((x) => (x.id === id ? { ...x, status: to } : x)),
        );
        setArrivals((a) => ({ ...a, [id]: Date.now() }));
        if (selectedIdRef.current === id) void loadDetail(id);
      } catch (e) {
        toast({
          title: e instanceof ApiRequestError ? e.message : 'Could not update order',
          variant: 'danger',
        });
      } finally {
        setBusy(null);
        setMoving(false);
      }
    },
    [onNewToken, toast, loadDetail],
  );

  const open = useCallback((id: string) => void loadDetail(id), [loadDetail]);

  function closeSheet() {
    setSelectedId(null);
    setDetail(null);
    setAskDanger(null);
  }

  const done = (orders ?? [])
    .filter((o) => o.status === 'COMPLETED')
    .slice(0, DONE_SHOWN);

  return (
    <div className="theme-dark flex h-[calc(100dvh-3.5rem)] flex-col overflow-y-auto bg-page px-4 pt-4 pb-2 text-ink md:h-dvh md:px-6">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Kitchen</h1>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 text-[12px]',
            live ? 'text-success-text' : 'text-ink-3',
          )}
        >
          <span
            aria-hidden
            className={cn('size-1.5 rounded-full', live ? 'bg-success' : 'bg-ink-3')}
          />
          {live ? 'Live' : 'Connecting…'}
        </span>
      </div>

      {orders === null ? (
        <div className="mt-4 grid flex-1 gap-4 md:grid-cols-3" aria-label="Loading kitchen board">
          {COLUMNS.map((c) => (
            <div key={c.status} className="space-y-3">
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-40" />
              <Skeleton className="h-40" />
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-4 grid min-h-0 flex-1 gap-4 md:grid-cols-3">
          {COLUMNS.map((col) => {
            const tickets = orders
              .filter((o) => o.status === col.status)
              .sort((a, b) => a.orderNumber - b.orderNumber);
            return (
              <section
                key={col.status}
                aria-labelledby={`col-${col.status}`}
                className="flex min-h-0 flex-col rounded-xl border border-line bg-surface/40"
              >
                <h2
                  id={`col-${col.status}`}
                  className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5 text-[13px] font-semibold tracking-wide uppercase"
                >
                  <col.icon aria-hidden className="size-4 text-ink-3" />
                  {col.title}
                  <Badge className="ml-auto tabular-nums">{tickets.length}</Badge>
                </h2>
                {tickets.length === 0 ? (
                  <EmptyState icon={col.icon} title={`No ${col.title.toLowerCase()} orders`} body={col.empty} />
                ) : (
                  <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 md:overflow-y-auto">
                    {tickets.map((o, i) => (
                      <Ticket
                        // Re-keyed by status so moving column replays the entrance.
                        key={`${o.id}:${o.status}`}
                        order={o}
                        index={i}
                        liveArrival={Boolean(arrivals[o.id])}
                        busy={busy === o.id}
                        onOpen={open}
                        onAdvance={advance}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      {/* Recently completed — out of the way but reachable without leaving the board. */}
      {done.length > 0 && (
        <details className="mt-3 shrink-0 rounded-xl border border-line bg-surface/40">
          <summary className="cursor-pointer list-none px-3 py-2.5 text-[13px] font-semibold tracking-wide uppercase select-none [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-2">
              <CheckCircle2 aria-hidden className="size-4 text-success-text" />
              Completed
              <Badge className="tabular-nums">{done.length}</Badge>
              <span className="text-[11px] font-normal text-ink-3 normal-case">tap to expand</span>
            </span>
          </summary>
          <ul className="flex flex-wrap gap-2 px-3 pb-3">
            {done.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => open(o.id)}
                  className="rounded-lg border border-line bg-surface px-3 py-2 text-[13px] transition-colors duration-120 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                >
                  <span className="font-mono font-semibold tabular-nums">#{o.orderNumber}</span>
                  <span className="ml-2 text-ink-3 tabular-nums">
                    {timeShort(o.placedAt ?? o.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <Sheet
        open={selectedId !== null}
        onClose={closeSheet}
        title={
          detail ? (
            <span className="flex items-center gap-2.5">
              <span className="font-mono">Order #{detail.order.orderNumber}</span>
              <StatusBadge status={detail.order.status} />
            </span>
          ) : (
            'Order'
          )
        }
      >
        {!detail ? (
          <div className="space-y-3" aria-label="Loading order">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-24" />
            <Skeleton className="h-40" />
          </div>
        ) : (
          <OrderDetail
            order={detail.order}
            timeline={detail.timeline}
            moving={moving}
            profile={profile}
            onMove={(to) =>
              DANGER_STATUSES.includes(to)
                ? setAskDanger(to)
                : void advance(detail.order.id, to)
            }
            onChanged={() => void loadDetail(detail.order.id)}
          />
        )}
      </Sheet>

      <ConfirmDialog
        open={askDanger !== null}
        onClose={() => setAskDanger(null)}
        onConfirm={(reason) => {
          if (detail && askDanger) void advance(detail.order.id, askDanger, reason);
          setAskDanger(null);
        }}
        title={askDanger === 'VOIDED' ? 'Void this order?' : 'Cancel this order?'}
        body={
          askDanger === 'VOIDED'
            ? 'Voiding reverses a recorded sale. The order stays on file with your name on the audit trail.'
            : 'The order stops here and is excluded from revenue. This cannot be undone.'
        }
        confirmLabel={askDanger === 'VOIDED' ? 'Void order' : 'Cancel order'}
        requireReason
      />
    </div>
  );
}

/**
 * One kitchen ticket. Memoised so a socket event re-renders only the changed
 * card — the ticking clock lives in <Elapsed>, which re-renders alone.
 */
const Ticket = memo(function Ticket({
  order,
  index,
  liveArrival,
  busy,
  onOpen,
  onAdvance,
}: {
  order: OrderSummary;
  index: number;
  liveArrival: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
  onAdvance: (id: string, to: string) => void;
}) {
  const quick = QUICK[order.status];
  const since = order.placedAt ?? order.createdAt;
  return (
    <li
      className={cn('list-none', liveArrival ? 'animate-slide-in-left' : 'animate-fade-up')}
      // Initial load staggers (capped, DESIGN.md §7); live arrivals land at once.
      style={liveArrival ? undefined : { animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      <div
        onClick={() => onOpen(order.id)}
        className="relative cursor-pointer overflow-hidden rounded-xl border border-line bg-surface p-3 transition-colors duration-120 hover:border-line-2"
      >
        {liveArrival && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ animation: 'flash 800ms var(--ease-out-quart) both' }}
          />
        )}
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(order.id);
            }}
            aria-label={`Open order #${order.orderNumber}`}
            className="rounded font-mono text-xl leading-none font-bold tracking-tight tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
          >
            #{order.orderNumber}
          </button>
          <span className="flex items-center gap-1.5">
            {order.orderType !== 'TAKEAWAY' && (
              <Badge variant={order.orderType === 'DELIVERY' ? 'info' : 'warning'}>
                {TYPE_LABEL[order.orderType] ?? order.orderType}
              </Badge>
            )}
            <Elapsed since={since} />
          </span>
        </div>

        {order.customer && (
          <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ink-2">
            <UserRound aria-hidden className="size-3.5 shrink-0 text-ink-3" />
            <span className="truncate">{order.customer.name}</span>
          </p>
        )}

        <ul className="mt-2.5 space-y-1.5">
          {order.items.map((i, idx) => (
            <li key={idx} className="text-[15px] leading-snug font-medium">
              <span className="text-ink-2 tabular-nums">{i.quantity} ×</span> {i.nameSnapshot}
              {i.notes && (
                <p className="text-[12px] font-normal text-ink-2">{i.notes}</p>
              )}
            </li>
          ))}
        </ul>

        {order.notes && (
          <p className="mt-2.5 rounded-lg bg-warning/10 px-2.5 py-1.5 text-[13px] leading-snug text-warning-text">
            {order.notes}
          </p>
        )}

        {quick && (
          <Button
            variant="primary"
            size="lg"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onAdvance(order.id, quick.to);
            }}
            className="mt-3 w-full"
          >
            {busy ? '…' : quick.label}
          </Button>
        )}
      </div>
    </li>
  );
});

/**
 * Self-ticking elapsed chip — the ONLY thing on the board that re-renders
 * every second. Calm → warning at 10m → critical at 20m with a slow
 * opacity pulse (never a flash); reduced motion collapses the pulse.
 */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const ms = Math.max(0, now - new Date(since).getTime());
  const mins = Math.floor(ms / 60_000);
  const label =
    ms >= 3_600_000
      ? `${Math.floor(mins / 60)}h ${mins % 60}m`
      : `${mins}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;
  const tone =
    ms >= CRIT_MS
      ? 'bg-danger/15 text-danger-text'
      : ms >= WARN_MS
        ? 'bg-warning/15 text-warning-text'
        : 'bg-surface-2 text-ink-2';

  return (
    <span
      role="timer"
      aria-label={`${mins} minutes elapsed`}
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 font-mono text-[13px] font-semibold tabular-nums',
        tone,
      )}
      style={ms >= CRIT_MS ? { animation: 'kds-pulse 2s ease-in-out infinite' } : undefined}
    >
      {label}
    </span>
  );
}
