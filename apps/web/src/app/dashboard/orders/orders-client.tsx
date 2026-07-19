'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Ban,
  BellRing,
  CheckCircle2,
  ChefHat,
  FileText,
  Receipt,
  Search,
  SearchX,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
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
import { cn } from '@/lib/cn';
import { formatMinor } from '@/lib/money';
import { nextStatuses } from '@/lib/order-status';
import { connectSocket } from '@/lib/socket';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/modal';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';

/**
 * Orders — the operational command centre. A table of everything the till has
 * rung up, with a persistent right-hand Sheet for any one order: you never
 * navigate away from the list. Live over the existing tenant socket.
 */

const FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'CANCELLED', label: 'Cancelled' },
  { key: 'VOIDED', label: 'Voided' },
] as const;
type FilterKey = (typeof FILTERS)[number]['key'];

/** Statuses with work left in them. Always recent, so client-side is exact. */
const ACTIVE_STATUSES = ['PLACED', 'PREPARING', 'READY'];

/**
 * Status rendering: icon + label + colour, never colour alone (DESIGN.md §2).
 * Colour = needs attention (info new, warning cooking, success ready);
 * neutral = done and archived; danger = money reversed.
 */
const STATUS_META: Record<
  string,
  { label: string; variant: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; icon: LucideIcon; dot: string }
> = {
  DRAFT: { label: 'Draft', variant: 'neutral', icon: FileText, dot: 'bg-ink-3' },
  PLACED: { label: 'Placed', variant: 'info', icon: Receipt, dot: 'bg-info' },
  PREPARING: { label: 'Preparing', variant: 'warning', icon: ChefHat, dot: 'bg-warning' },
  READY: { label: 'Ready', variant: 'success', icon: BellRing, dot: 'bg-success' },
  COMPLETED: { label: 'Completed', variant: 'neutral', icon: CheckCircle2, dot: 'bg-ink-3' },
  CANCELLED: { label: 'Cancelled', variant: 'danger', icon: XCircle, dot: 'bg-danger' },
  VOIDED: { label: 'Voided', variant: 'danger', icon: Ban, dot: 'bg-danger' },
};

/** The one obvious next step per status — the row's quick action. */
const QUICK: Record<string, { to: string; label: string }> = {
  PLACED: { to: 'PREPARING', label: 'Start' },
  PREPARING: { to: 'READY', label: 'Ready' },
  READY: { to: 'COMPLETED', label: 'Complete' },
};

/** Reversing money always goes through a ConfirmDialog with a typed reason. */
const DANGER_STATUSES = ['CANCELLED', 'VOIDED'];

const PAYMENT_LABEL: Record<string, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  CARD: 'Card',
  WALLET: 'Wallet',
};

function statusLabel(s: string | null): string {
  return (s && STATUS_META[s]?.label) ?? (s ?? '');
}

function timeShort(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${time}`;
}

function timeFull(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Local calendar day (YYYY-MM-DD) for the native date filter. */
function localDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA');
}

export function OrdersClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [filter, setFilter] = useState<FilterKey>('ALL');
  const [q, setQ] = useState('');
  const [day, setDay] = useState('');
  const [live, setLive] = useState(false);
  // Row id → last-change timestamp; keying the row on it replays the flash.
  const [flash, setFlash] = useState<Record<string, number>>({});
  const [busyRow, setBusyRow] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ order: Order; timeline: TimelineEvent[] } | null>(null);
  const [askDanger, setAskDanger] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  // Fresh values for socket handlers without re-subscribing the socket.
  const tokenRef = useRef(accessToken);
  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);
  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // Terminal statuses use the server filter (reaches past the 100 most recent
  // rows); ALL/ACTIVE share one unfiltered fetch, ACTIVE narrowed client-side.
  const serverStatus = filter === 'ALL' || filter === 'ACTIVE' ? undefined : filter;

  const refetch = useCallback(async () => {
    const token = tokenRef.current;
    if (!token) return;
    try {
      setOrders(await listOrders(token, onNewToken, serverStatus));
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not load orders',
        variant: 'danger',
      });
    }
  }, [onNewToken, serverStatus, toast]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // setState only inside .then/.catch callbacks — the effect-friendly shape
  // (react-hooks/set-state-in-effect traces plain async fns too).
  const loadDetail = useCallback(
    (id: string): Promise<void> => {
      const token = tokenRef.current;
      if (!token) return Promise.resolve();
      return Promise.all([
        getOrder(token, onNewToken, id),
        getTimeline(token, onNewToken, id),
      ])
        .then(([order, timeline]) => {
          // Also claims the selection so a ?id= deep link opens the Sheet
          // once the order has actually loaded (no-op when already open).
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

  function open(id: string) {
    setSelectedId(id);
    setDetail(null);
    // Shallow URL update so the order is linkable (command palette lands here).
    window.history.replaceState(null, '', `?id=${id}`);
    void loadDetail(id);
  }

  function close() {
    setSelectedId(null);
    setDetail(null);
    setAskDanger(null);
    window.history.replaceState(null, '', window.location.pathname);
  }

  // ?id= deep link — once, when a token exists to fetch with.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (!accessToken || deepLinked.current) return;
    deepLinked.current = true;
    const id = new URLSearchParams(window.location.search).get('id');
    if (id) void loadDetail(id);
  }, [accessToken, loadDetail]);

  // Live updates over the existing per-tenant socket (same pattern as the
  // kitchen board): refetch on any order event, flash the changed row, and
  // keep an open Sheet current. Never a page reload.
  useEffect(() => {
    if (!accessToken) return;
    const socket = connectSocket(accessToken);
    const onEvent = (p: { id: string }) => {
      setFlash((f) => ({ ...f, [p.id]: Date.now() }));
      void refetch();
      if (selectedIdRef.current === p.id) void loadDetail(p.id);
    };
    socket.on('connect', () => setLive(true));
    socket.on('disconnect', () => setLive(false));
    socket.on('order.created', onEvent);
    socket.on('order.status_changed', onEvent);
    return () => {
      socket.close();
    };
    // Reconnect only when the identity changes, not on every refetch tweak.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  async function move(id: string, to: string, reason?: string) {
    if (!accessToken) return;
    setMoving(true);
    try {
      await updateOrderStatus(accessToken, onNewToken, id, to, reason);
      setFlash((f) => ({ ...f, [id]: Date.now() }));
      toast({ title: `Order moved to ${statusLabel(to)}`, variant: 'success' });
      await Promise.all([refetch(), selectedIdRef.current === id ? loadDetail(id) : null]);
    } catch (e) {
      // A 403 here is the server refusing a void to someone without
      // order.void — surfaced verbatim rather than hidden.
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not update order',
        variant: 'danger',
      });
    } finally {
      setMoving(false);
    }
  }

  async function quickAdvance(o: OrderSummary) {
    const next = QUICK[o.status];
    if (!next) return;
    setBusyRow(o.id);
    await move(o.id, next.to);
    setBusyRow(null);
  }

  const query = q.trim().toLowerCase().replace(/^#/, '');
  const rows = (orders ?? []).filter((o) => {
    if (filter === 'ACTIVE' && !ACTIVE_STATUSES.includes(o.status)) return false;
    if (day && localDay(o.createdAt) !== day) return false;
    if (!query) return true;
    return (
      String(o.orderNumber).includes(query) ||
      (o.customer?.name.toLowerCase().includes(query) ?? false)
    );
  });

  const filtering = filter !== 'ALL' || query !== '' || day !== '';
  const loading = orders === null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Orders</h1>
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

      {/* Toolbar: status segments + search + day — existing backend reach only. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Segmented options={FILTERS} value={filter} onChange={setFilter} />
        <div className="relative min-w-0 flex-1 basis-52 sm:max-w-xs">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3"
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQ('');
            }}
            placeholder="Order # or customer…"
            aria-label="Search orders"
            className="pl-9"
          />
        </div>
        <Input
          type="date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
          aria-label="Filter by day"
          // max-w, not w-auto: cn() doesn't resolve conflicts with the base w-full.
          className="max-w-40"
        />
        {filtering && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFilter('ALL');
              setQ('');
              setDay('');
            }}
          >
            Clear
          </Button>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
        {loading ? (
          <div className="space-y-2 p-4" aria-label="Loading orders">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          filtering ? (
            <EmptyState
              icon={SearchX}
              title="No matching orders"
              body="Nothing in the most recent orders matches these filters."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setFilter('ALL');
                    setQ('');
                    setDay('');
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Receipt}
              title="No orders yet"
              body="Every order rung up at the till lands here, live."
              action={
                <Link
                  href="/dashboard/pos"
                  className="text-sm font-medium underline-offset-4 hover:underline"
                >
                  Take your first order in POS →
                </Link>
              }
            />
          )
        ) : (
          <Table containerClassName="max-h-[calc(100dvh-16.5rem)] overflow-y-auto rounded-xl">
            <thead>
              <tr>
                <Th>Order</Th>
                <Th className="hidden md:table-cell">Customer</Th>
                <Th>Status</Th>
                <Th className="hidden sm:table-cell">Payment</Th>
                <Th numeric>Amount</Th>
                <Th className="hidden sm:table-cell">Created</Th>
                <Th className="w-px" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const meta = STATUS_META[o.status];
                const quick = QUICK[o.status];
                const pay = o.payments[0];
                return (
                  // Keyed on the last change so a socket event replays the flash.
                  <Tr
                    key={`${o.id}:${flash[o.id] ?? 0}`}
                    onClick={() => open(o.id)}
                    aria-selected={selectedId === o.id}
                    className={cn(
                      'animate-fade-up',
                      selectedId === o.id && 'bg-surface-2',
                    )}
                    style={flash[o.id] ? { animation: 'flash 800ms var(--ease-out-quart) both' } : undefined}
                  >
                    <Td>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          open(o.id);
                        }}
                        className="rounded font-mono font-medium tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                      >
                        #{o.orderNumber}
                      </button>
                      <span className="ml-2 text-[12px] text-ink-3 tabular-nums">
                        {o._count.items} item{o._count.items === 1 ? '' : 's'}
                      </span>
                    </Td>
                    <Td className="hidden max-w-40 truncate md:table-cell">
                      {o.customer?.name ?? <span className="text-ink-3">Walk-in</span>}
                    </Td>
                    <Td>
                      {meta ? (
                        <Badge variant={meta.variant}>
                          <meta.icon aria-hidden className="size-3" />
                          {meta.label}
                        </Badge>
                      ) : (
                        <Badge>{o.status}</Badge>
                      )}
                    </Td>
                    <Td className="hidden sm:table-cell">
                      {pay ? (
                        <>
                          {PAYMENT_LABEL[pay.method] ?? pay.method}
                          {pay.status !== 'CAPTURED' && (
                            <span className="ml-1.5 text-[11px] text-ink-3">
                              {pay.status.toLowerCase()}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </Td>
                    <Td numeric className="font-medium">
                      {formatMinor(o.totalMinor)}
                    </Td>
                    <Td
                      className="hidden text-ink-2 tabular-nums sm:table-cell"
                      title={timeFull(o.createdAt)}
                    >
                      {timeShort(o.placedAt ?? o.createdAt)}
                    </Td>
                    <Td className="py-1.5 text-right">
                      {quick && (
                        <Button
                          size="sm"
                          disabled={busyRow === o.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            void quickAdvance(o);
                          }}
                        >
                          {quick.label}
                        </Button>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>
      {!loading && rows.length > 0 && (
        <p className="mt-2 text-[12px] text-ink-3 tabular-nums">
          {rows.length} order{rows.length === 1 ? '' : 's'}
          {orders !== null && orders.length >= 100 && ' · showing the 100 most recent'}
        </p>
      )}

      <Sheet
        open={selectedId !== null}
        onClose={close}
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
            onMove={(to) =>
              DANGER_STATUSES.includes(to) ? setAskDanger(to) : void move(detail.order.id, to)
            }
          />
        )}
      </Sheet>

      <ConfirmDialog
        open={askDanger !== null}
        onClose={() => setAskDanger(null)}
        onConfirm={(reason) => {
          if (detail && askDanger) void move(detail.order.id, askDanger, reason);
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

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status];
  if (!meta) return <Badge>{status}</Badge>;
  return (
    <Badge variant={meta.variant}>
      <meta.icon aria-hidden className="size-3" />
      {meta.label}
    </Badge>
  );
}

function OrderDetail({
  order,
  timeline,
  moving,
  onMove,
}: {
  order: Order;
  timeline: TimelineEvent[];
  moving: boolean;
  onMove: (to: string) => void;
}) {
  const next = nextStatuses(order.status);
  const forward = next.filter((s) => !DANGER_STATUSES.includes(s));
  const danger = next.filter((s) => DANGER_STATUSES.includes(s));

  return (
    <div className="space-y-6">
      <div>
        <p className="text-2xl font-semibold tracking-tight tabular-nums">
          {formatMinor(order.totalMinor)}
        </p>
        <p className="mt-0.5 text-[12px] text-ink-3">
          {timeFull(order.placedAt ?? order.createdAt)}
        </p>
      </div>

      {next.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {forward.map((s) => (
            <Button key={s} variant="primary" size="sm" disabled={moving} onClick={() => onMove(s)}>
              {statusLabel(s)}
            </Button>
          ))}
          {danger.map((s) => (
            <Button key={s} variant="danger" size="sm" disabled={moving} onClick={() => onMove(s)}>
              {s === 'VOIDED' ? 'Void' : 'Cancel'}
            </Button>
          ))}
        </div>
      )}

      <Section label="Timeline">
        <Timeline events={timeline} />
      </Section>

      <Section label="Items">
        <ul className="space-y-1.5">
          {order.items.map((i) => (
            <li key={i.id} className="text-[13px]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate">
                  <span className="text-ink-2 tabular-nums">{i.quantity} ×</span> {i.nameSnapshot}
                </span>
                <span className="shrink-0 tabular-nums">{formatMinor(i.lineTotalMinor)}</span>
              </div>
              {i.notes && <p className="text-[12px] text-ink-3">{i.notes}</p>}
            </li>
          ))}
        </ul>
        <dl className="mt-3 space-y-1 border-t border-line pt-2 text-[13px]">
          <div className="flex justify-between">
            <dt className="text-ink-2">Subtotal</dt>
            <dd className="tabular-nums">{formatMinor(order.subtotalMinor)}</dd>
          </div>
          {order.discountMinor > 0 && (
            <div className="flex justify-between text-success-text">
              <dt>Coupon discount</dt>
              <dd className="tabular-nums">−{formatMinor(order.discountMinor)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-ink-2">Tax</dt>
            <dd className="tabular-nums">{formatMinor(order.taxMinor)}</dd>
          </div>
          <div className="flex justify-between border-t border-line pt-1.5 font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{formatMinor(order.totalMinor)}</dd>
          </div>
        </dl>
      </Section>

      <Section label="Customer">
        {order.customer ? (
          <div className="text-[13px]">
            <p className="font-medium">{order.customer.name}</p>
            <p className="mt-0.5 font-mono text-[12px] text-ink-2 tabular-nums">
              {order.customer.phone}
            </p>
          </div>
        ) : (
          <p className="text-[13px] text-ink-3">Walk-in — no customer attached.</p>
        )}
      </Section>

      <Section label="Payment">
        {order.payments.length === 0 ? (
          <p className="text-[13px] text-ink-3">No payment recorded.</p>
        ) : (
          <ul className="space-y-1.5">
            {order.payments.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 text-[13px]">
                <span className="flex items-center gap-2">
                  {PAYMENT_LABEL[p.method] ?? p.method}
                  <Badge variant={p.status === 'CAPTURED' ? 'success' : 'neutral'}>
                    {p.status.toLowerCase()}
                  </Badge>
                </span>
                <span className="tabular-nums">{formatMinor(p.amountMinor)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {order.notes && (
        <Section label="Notes">
          <p className="text-[13px] whitespace-pre-wrap text-ink-2">{order.notes}</p>
        </Section>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-label mb-2">{label}</h3>
      {children}
    </section>
  );
}

/**
 * The order's append-only audit trail (order_events) as a vertical rail.
 * Every event names what happened and, for voids/cancels, the typed reason.
 */
function Timeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return <p className="text-[13px] text-ink-3">No events recorded.</p>;
  }
  return (
    <ol className="relative ml-1 space-y-4 border-l border-line pl-5">
      {events.map((e, i) => {
        const meta = e.toStatus ? STATUS_META[e.toStatus] : undefined;
        const reason = typeof e.metadata?.reason === 'string' ? e.metadata.reason : null;
        return (
          <li
            key={e.id}
            className="relative animate-fade-up"
            // Stagger capped at 8 (DESIGN.md §7) — later events land together.
            style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
          >
            <span
              aria-hidden
              className={cn(
                'absolute top-1 -left-[26px] size-2.5 rounded-full ring-4 ring-surface',
                meta?.dot ?? 'bg-ink-3',
              )}
            />
            <p className="text-[13px] leading-tight font-medium">
              {e.type === 'CREATED'
                ? 'Order placed'
                : `${statusLabel(e.fromStatus)} → ${statusLabel(e.toStatus)}`}
            </p>
            <p className="mt-0.5 text-[12px] text-ink-3 tabular-nums">{timeFull(e.createdAt)}</p>
            {reason && <p className="mt-0.5 text-[12px] text-ink-2">“{reason}”</p>}
          </li>
        );
      })}
    </ol>
  );
}
