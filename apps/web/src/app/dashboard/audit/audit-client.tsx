'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  Receipt,
  RotateCcw,
  ScrollText,
  Search,
  ShoppingCart,
  Sparkles,
  Store,
  UserCog,
  UserRoundPlus,
  type LucideIcon,
} from 'lucide-react';
import { ApiRequestError, getAuditLog, type AuditEntry } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatMinor } from '@/lib/money';
import { timeFull, timeShort } from '../orders/order-detail';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';

/**
 * The restaurant Timeline — one operational history, read straight off the
 * append-only `audit_logs` (via GET /reports/audit). This screen is the M0
 * event seam's first reader: it introduces NO new store, it just surfaces,
 * groups and filters what every feature already records. audit.read only
 * (owner/manager). Source is append-only, so this is also the immutable record.
 */

const PAGE = 50;

type Cat =
  | 'orders'
  | 'refunds'
  | 'customers'
  | 'loyalty'
  | 'staff'
  | 'settings'
  | 'procurement'
  | 'other';
type Variant = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/** Filter chips — mirror the server's categories (ReportsService.CATEGORY_ACTION),
 *  plus "All". Kitchen/inventory/cash/security are absent here for the same
 *  reason they are absent server-side: they live in their own ledgers. */
const CATEGORIES = [
  { key: 'all', label: 'All' },
  { key: 'orders', label: 'Orders' },
  { key: 'refunds', label: 'Refunds' },
  { key: 'customers', label: 'Customers' },
  { key: 'loyalty', label: 'Loyalty' },
  { key: 'staff', label: 'Staff' },
  { key: 'settings', label: 'Settings' },
] as const;

const RANGES = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: '7 days' },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

/** action -> category. Refund is a deliberate subset of orders. Mirrors the
 *  server mapping so a chip and its rows always agree. */
function categoryOf(action: string): Cat {
  if (action === 'order.refunded') return 'refunds';
  if (action.startsWith('order.')) return 'orders';
  if (action.startsWith('customer.')) return 'customers';
  if (action.startsWith('loyalty.')) return 'loyalty';
  if (action.startsWith('staff.')) return 'staff';
  if (action.startsWith('po.')) return 'procurement';
  if (action.startsWith('restaurant.')) return 'settings';
  return 'other';
}

const CAT_ICON: Record<Cat, LucideIcon> = {
  orders: Receipt,
  refunds: RotateCcw,
  customers: UserRoundPlus,
  loyalty: Sparkles,
  staff: UserCog,
  settings: Store,
  procurement: ShoppingCart,
  other: ScrollText,
};

const ACTION_LABEL: Record<string, string> = {
  'restaurant.created': 'Restaurant created',
  'restaurant.updated': 'Business profile updated',
  'order.discounted': 'Discount applied',
  'order.voided': 'Order voided',
  'order.refunded': 'Refund issued',
  'customer.created': 'New customer added',
  'loyalty.earned': 'Points earned',
  'loyalty.redeemed': 'Points redeemed',
  'loyalty.adjusted': 'Points adjusted',
  'loyalty.refund_reversed': 'Points reversed',
  'staff.invited': 'Staff invited',
  'staff.invite_revoked': 'Invite revoked',
  'staff.joined': 'Staff joined',
  'staff.updated': 'Staff updated',
  'staff.deactivated': 'Staff deactivated',
  'po.created': 'Purchase order drafted',
  'po.ordered': 'Purchase order placed',
  'po.received': 'Stock received',
  'po.cancelled': 'Purchase order cancelled',
};

/** Severity tone. Money-out and access-removal are the loud ones; the icon +
 *  text always carry the meaning too, so colour is never the sole signal. */
const ACTION_VARIANT: Record<string, Variant> = {
  'order.voided': 'danger',
  'staff.deactivated': 'danger',
  'order.refunded': 'warning',
  'order.discounted': 'warning',
  'loyalty.earned': 'success',
  'customer.created': 'success',
  'staff.joined': 'success',
  'loyalty.redeemed': 'info',
  'loyalty.adjusted': 'info',
  'loyalty.refund_reversed': 'info',
  'restaurant.updated': 'info',
  'staff.invited': 'info',
  'po.received': 'success',
  'po.ordered': 'info',
  'po.cancelled': 'danger',
};

/** Icon-chip tint per tone — the same tokens the Badge primitive uses. */
const CHIP: Record<Variant, string> = {
  neutral: 'bg-surface-2 text-ink-2',
  success: 'bg-success/10 text-success-text',
  warning: 'bg-warning/10 text-warning-text',
  danger: 'bg-danger/10 text-danger-text',
  info: 'bg-info/10 text-info-text',
};

const pts = (n: number) => `${n > 0 ? '+' : ''}${n.toLocaleString('en-IN')} pts`;

/** A human sentence from the row's action + metadata. Reads only ids, amounts
 *  and short labels — the only things the event seam is allowed to store. */
function describe(e: AuditEntry): string {
  const m = e.metadata ?? {};
  const parts: string[] = [ACTION_LABEL[e.action] ?? e.action];
  if (typeof m.orderNumber === 'number') parts.push(`#${m.orderNumber}`);
  if (typeof m.points === 'number') parts.push(pts(m.points));
  if (typeof m.amountMinor === 'number') parts.push(formatMinor(m.amountMinor));
  else if (typeof m.discountMinor === 'number')
    parts.push(formatMinor(m.discountMinor));
  if (typeof m.role === 'string' && m.role) parts.push(m.role);
  if (typeof m.email === 'string' && m.email) parts.push(m.email);
  if (typeof m.reason === 'string' && m.reason) parts.push(`— “${m.reason}”`);
  return parts.join(' ');
}

/** Where a row opens — the EXISTING detail views, reached by their deep link.
 *  No detail is duplicated here; the row is just a link. */
function hrefFor(e: AuditEntry): string | null {
  if (!e.entityId) return null;
  const c = categoryOf(e.action);
  if (c === 'orders' || c === 'refunds')
    return `/dashboard/orders?id=${e.entityId}`;
  if (c === 'customers' || c === 'loyalty')
    return `/dashboard/customers?id=${e.entityId}`;
  return null; // staff / settings: no per-row profile page
}

/** Grouped by local calendar day, with a Today/Yesterday/date heading. */
function dayHeading(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString();
  const yest = new Date(Date.now() - 864e5).toDateString();
  if (d.toDateString() === today) return 'Today';
  if (d.toDateString() === yest) return 'Yesterday';
  return d.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;

/** A preset -> the inclusive IST-day bounds the API expects. */
function rangeBounds(r: RangeKey): { from?: string; to?: string } {
  const now = new Date();
  if (r === 'today') return { from: ymd(now), to: ymd(now) };
  if (r === 'yesterday') {
    const y = new Date(Date.now() - 864e5);
    return { from: ymd(y), to: ymd(y) };
  }
  if (r === '7d') return { from: ymd(new Date(Date.now() - 6 * 864e5)), to: ymd(now) };
  return {};
}

function Entry({ e }: { e: AuditEntry }) {
  const cat = categoryOf(e.action);
  const Icon = CAT_ICON[cat];
  const tone = ACTION_VARIANT[e.action] ?? 'neutral';
  const href = hrefFor(e);
  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          'mt-0.5 grid size-8 shrink-0 place-items-center rounded-full',
          CHIP[tone],
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-ink">{describe(e)}</span>
        <span className="mt-0.5 block text-[12px] text-ink-3">
          {e.actor?.name && (
            <>
              <span className="text-ink-2">{e.actor.name}</span>
              {' · '}
            </>
          )}
          <time dateTime={e.createdAt} title={timeFull(e.createdAt)}>
            {timeShort(e.createdAt)}
          </time>
        </span>
      </span>
      {href && (
        <ChevronRight aria-hidden className="mt-1.5 size-4 shrink-0 text-ink-3" />
      )}
    </>
  );
  const cls = 'flex items-start gap-3 px-4 py-3';
  return href ? (
    <Link
      href={href}
      className={cn(
        cls,
        'transition-colors duration-120 hover:bg-surface-2',
        'focus-visible:bg-surface-2 focus-visible:outline-none',
      )}
    >
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function AuditClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [category, setCategory] = useState<string>('all');
  const [range, setRange] = useState<RangeKey>('all');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');

  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const tokenRef = useRef(accessToken);
  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  // Debounce the search box, like the customers list.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const filters = useMemo(() => {
    const { from, to } = rangeBounds(range);
    return {
      category: category === 'all' ? undefined : category,
      from,
      to,
      q: q || undefined,
    };
  }, [category, range, q]);
  const filtered = category !== 'all' || range !== 'all' || q !== '';

  // First page — refetches whenever a filter changes. The list is replaced on
  // arrival rather than blanked first (same as the customers list), so a filter
  // switch never flashes an empty card.
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    getAuditLog(accessToken, onNewToken, { ...filters, limit: PAGE })
      .then((page) => {
        if (cancelled) return;
        setRows(page);
        setHasMore(page.length === PAGE);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          toast({
            title:
              e instanceof ApiRequestError ? e.message : 'Could not load the timeline',
            variant: 'danger',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, filters, onNewToken, toast]);

  const loadMore = useCallback(async () => {
    const token = tokenRef.current;
    if (!token || loadingMore || !rows?.length) return;
    setLoadingMore(true);
    try {
      const page = await getAuditLog(token, onNewToken, {
        ...filters,
        cursor: rows[rows.length - 1].id,
        limit: PAGE,
      });
      setRows((prev) => {
        const seen = new Set((prev ?? []).map((r) => r.id));
        return [...(prev ?? []), ...page.filter((r) => !seen.has(r.id))];
      });
      setHasMore(page.length === PAGE);
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not load more',
        variant: 'danger',
      });
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, rows, filters, onNewToken, toast]);

  // Contiguous same-day runs become groups (rows already arrive newest-first).
  const groups = useMemo(() => {
    if (!rows) return null;
    const out: Array<{ key: string; heading: string; items: AuditEntry[] }> = [];
    for (const e of rows) {
      const key = new Date(e.createdAt).toDateString();
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(e);
      else out.push({ key, heading: dayHeading(e.createdAt), items: [e] });
    }
    return out;
  }, [rows]);

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Timeline</h1>
      <p className="mt-1 text-[13px] text-ink-3">
        Every action across your restaurant, newest first — orders, refunds,
        customers, loyalty and staff. This record cannot be edited or deleted.
      </p>

      <div className="mt-4 space-y-3">
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label="Filter by category"
        >
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              type="button"
              aria-pressed={category === c.key}
              onClick={() => setCategory(c.key)}
              className={cn(
                'rounded-full border px-3 py-1 text-[13px] transition-colors duration-120',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current',
                category === c.key
                  ? 'border-ink bg-ink text-surface'
                  : 'border-line-2 text-ink-2 hover:bg-surface-2 hover:text-ink',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Segmented options={RANGES} value={range} onChange={setRange} />
          <div className="relative sm:w-64">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search activity"
              aria-label="Search activity"
              className="pl-9"
            />
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
        {rows === null ? (
          <div
            className="space-y-2 p-4"
            role="status"
            aria-busy="true"
            aria-label="Loading timeline"
          >
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={filtered ? 'No matching activity' : 'Nothing logged yet'}
            body={
              filtered
                ? 'Try a wider date range or a different category.'
                : 'Orders, refunds, loyalty and staff changes will appear here as they happen.'
            }
          />
        ) : (
          <ul>
            {groups!.map((g) => (
              <li key={g.key} className="border-b border-line last:border-b-0">
                <p className="text-label bg-surface-2/50 px-4 py-1.5">
                  {g.heading}
                </p>
                <ul className="divide-y divide-line">
                  {g.items.map((e) => (
                    <li key={e.id}>
                      <Entry e={e} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>

      {rows !== null && rows.length > 0 && (
        <div className="mt-2 flex items-center gap-3">
          <p className="text-[12px] text-ink-3 tabular-nums">
            {rows.length} entr{rows.length === 1 ? 'y' : 'ies'}
            {hasMore && ' · older activity available'}
          </p>
          {hasMore && (
            <Button
              variant="ghost"
              size="sm"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? 'Loading…' : 'Load older'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
