'use client';

import {
  Ban,
  BellRing,
  CheckCircle2,
  ChefHat,
  FileText,
  MessageCircle,
  Printer,
  Receipt,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { Order, RestaurantProfile, TimelineEvent } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatMinor } from '@/lib/money';
import { nextStatuses } from '@/lib/order-status';
import {
  BillReceipt,
  KotTicket,
  buildShareText,
  usePrintArea,
  waShareUrl,
} from '@/lib/receipt';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/*
 * Order presentation shared by the Orders page (D6) and the kitchen board
 * (D7): status rendering, the detail Sheet body and its timeline. One home so
 * a status can never look different on two screens.
 */

/**
 * Status rendering: icon + label + colour, never colour alone (DESIGN.md §2).
 * Colour = needs attention (info new, warning cooking, success ready);
 * neutral = done and archived; danger = money reversed.
 */
export const STATUS_META: Record<
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

/** The one obvious next step per status — row quick actions, KDS ticket buttons. */
export const QUICK: Record<string, { to: string; label: string }> = {
  PLACED: { to: 'PREPARING', label: 'Start' },
  PREPARING: { to: 'READY', label: 'Ready' },
  READY: { to: 'COMPLETED', label: 'Complete' },
};

/** Reversing money always goes through a ConfirmDialog with a typed reason. */
export const DANGER_STATUSES = ['CANCELLED', 'VOIDED'];

export const PAYMENT_LABEL: Record<string, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  CARD: 'Card',
  WALLET: 'Wallet',
};

export function statusLabel(s: string | null): string {
  return (s && STATUS_META[s]?.label) ?? (s ?? '');
}

export function timeShort(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${time}`;
}

export function timeFull(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status];
  if (!meta) return <Badge>{status}</Badge>;
  return (
    <Badge variant={meta.variant}>
      <meta.icon aria-hidden className="size-3" />
      {meta.label}
    </Badge>
  );
}

export function OrderDetail({
  order,
  timeline,
  moving,
  onMove,
  profile,
}: {
  order: Order;
  timeline: TimelineEvent[];
  moving: boolean;
  onMove: (to: string) => void;
  /** Business profile for receipts; buttons wait until it has loaded. */
  profile?: RestaurantProfile | null;
}) {
  const next = nextStatuses(order.status);
  const forward = next.filter((s) => !DANGER_STATUSES.includes(s));
  const danger = next.filter((s) => DANGER_STATUSES.includes(s));
  const { printNode, portal } = usePrintArea();

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

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!profile}
          title={profile ? 'Print the customer bill' : 'Loading business profile…'}
          onClick={() =>
            profile && printNode(<BillReceipt order={order} profile={profile} />)
          }
        >
          <Printer aria-hidden className="size-3.5" />
          Print bill
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => printNode(<KotTicket order={order} profile={profile ?? null} />)}
        >
          <ChefHat aria-hidden className="size-3.5" />
          Print KOT
        </Button>
        {profile && (
          <Button
            variant="secondary"
            size="sm"
            title={
              order.customer
                ? `Send the bill to ${order.customer.name} on WhatsApp`
                : 'Share the bill on WhatsApp'
            }
            onClick={() =>
              window.open(
                waShareUrl(buildShareText(order, profile), order.customer?.phone),
                '_blank',
                'noopener,noreferrer',
              )
            }
          >
            <MessageCircle aria-hidden className="size-3.5" />
            Share
          </Button>
        )}
      </div>
      {portal}

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
