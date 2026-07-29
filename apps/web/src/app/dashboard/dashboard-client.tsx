'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChefHat,
  ChevronRight,
  FileText,
  Megaphone,
  Package,
  Receipt,
  Sparkles,
  Store,
  TrendingUp,
  Users,
  type LucideIcon,
} from 'lucide-react';
import {
  ApiRequestError,
  getAnalytics,
  getInsights,
  getMe,
  listActiveOrders,
  listIngredients,
  type AiInsight,
  type AnalyticsOverview,
  type OrderSummary,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatMinor, formatMinorCompact } from '@/lib/money';
import { fillSeries, hourLabel, pctDelta } from '@/lib/series';
import { connectSocket } from '@/lib/socket';
import { AreaLine } from '@/components/charts/area-line';
import { Bars } from '@/components/charts/bars';
import { RowBars } from '@/components/charts/row-bars';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';

const RANGES = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

const QUICK_ACTIONS: Array<{ label: string; href: string; icon: LucideIcon }> = [
  { label: 'Take order', href: '/dashboard/pos', icon: Store },
  { label: 'Kitchen', href: '/dashboard/kitchen', icon: ChefHat },
  { label: 'Customers', href: '/dashboard/customers', icon: Users },
  { label: 'Inventory', href: '/dashboard/inventory', icon: Package },
  { label: 'Reports', href: '/dashboard/reports', icon: FileText },
  { label: 'Coupons', href: '/dashboard/marketing', icon: Megaphone },
];

const ACTIVE_STATUSES = ['PLACED', 'PREPARING', 'READY'];

/** What a status change means in feed language. Only real socket events land here. */
const STATUS_TEXT: Record<string, string> = {
  PREPARING: 'started in the kitchen',
  READY: 'ready to serve',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  VOIDED: 'voided',
};

type FeedEntry = { uid: number; icon: LucideIcon; text: string; at: Date };

function greeting(): string {
  const h = Number(
    new Intl.DateTimeFormat('en-IN', {
      hour: 'numeric',
      hour12: false,
      timeZone: 'Asia/Kolkata',
    }).format(new Date()),
  );
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export function DashboardClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);

  const [today, setToday] = useState<AnalyticsOverview | null>(null);
  const [week, setWeek] = useState<AnalyticsOverview | null>(null);
  const [hero, setHero] = useState<AnalyticsOverview | null>(null);
  const [range, setRange] = useState<RangeKey>('7d');
  const [insights, setInsights] = useState<AiInsight[]>([]);
  const [lowStock, setLowStock] = useState<number | null>(null);
  const [active, setActive] = useState<OrderSummary[]>([]);
  const [firstName, setFirstName] = useState('');
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const feedUid = useRef(0);

  // One load, all existing endpoints, in parallel.
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const [t, w, ins, low, act, me] = await Promise.all([
          getAnalytics(accessToken, onNewToken, 'today'),
          getAnalytics(accessToken, onNewToken, '7d'),
          getInsights(accessToken, onNewToken),
          listIngredients(accessToken, onNewToken, { lowOnly: true }),
          listActiveOrders(accessToken, onNewToken),
          getMe(accessToken),
        ]);
        if (cancelled) return;
        setToday(t);
        setWeek(fillSeries(w));
        setInsights(
          [...ins.insights].sort((a, b) =>
            a.severity === b.severity ? 0 : a.severity === 'warning' ? -1 : 1,
          ),
        );
        setLowStock(low.length);
        setActive(act.filter((o) => ACTIVE_STATUSES.includes(o.status)));
        setFirstName(me.user.name.split(' ')[0]);
        setFeed(
          act.slice(0, 6).map((o) => ({
            uid: feedUid.current++,
            icon: Receipt,
            text: `Order #${o.orderNumber} · ${o.status.toLowerCase()}`,
            at: new Date(o.createdAt),
          })),
        );
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiRequestError ? e.message : 'Could not load the dashboard');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken]);

  // Hero ranges beyond the already-loaded 7d. `hero.range` gates display, so
  // a stale previous range shows a skeleton, never mislabeled data.
  useEffect(() => {
    if (!accessToken || range === '7d') return;
    let cancelled = false;
    getAnalytics(accessToken, onNewToken, range)
      .then((d) => {
        if (!cancelled) setHero(fillSeries(d));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, range]);

  // Live feed from the two real socket events (order.created / status_changed).
  useEffect(() => {
    if (!accessToken) return;
    const socket = connectSocket(accessToken);
    const push = (icon: LucideIcon, text: string) =>
      setFeed((prev) =>
        [{ uid: feedUid.current++, icon, text, at: new Date() }, ...prev].slice(0, 8),
      );
    socket.on('connect', () => setLive(true));
    socket.on('disconnect', () => setLive(false));
    socket.on('order.created', (p: { orderNumber: number }) =>
      push(Receipt, `Order #${p.orderNumber} placed`),
    );
    socket.on('order.status_changed', (p: { orderNumber: number; status: string }) => {
      const text = STATUS_TEXT[p.status];
      if (text) {
        push(p.status === 'READY' ? ChefHat : CheckCircle2, `Order #${p.orderNumber} ${text}`);
      }
    });
    return () => {
      socket.close();
    };
  }, [accessToken]);

  if (error) {
    return (
      <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-text">
        {error}
      </p>
    );
  }

  if (!today || !week) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading dashboard">
        <Skeleton className="h-7 w-64" />
        <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-80 lg:col-span-2" />
          <Skeleton className="h-80" />
        </div>
      </div>
    );
  }

  // ---- Derivations from real data only ----
  const series = week.revenueSeries;
  const t = series.at(-1);
  const y = series.at(-2);
  const revDelta = t && y ? pctDelta(t.revenueMinor, y.revenueMinor) : null;
  const orderDelta = t && y ? pctDelta(t.orders, y.orders) : null;
  const avgOf = (p: { revenueMinor: number; orders: number }) =>
    p.orders > 0 ? p.revenueMinor / p.orders : 0;
  const avgDelta = t && y && avgOf(y) > 0 ? pctDelta(avgOf(t), avgOf(y)) : null;

  const coldStart = today.summary.orders === 0 && series.every((d) => d.revenueMinor === 0);
  const heroData = range === '7d' ? week : hero && hero.range === range ? hero : null;
  const heroTotal = heroData
    ? heroData.revenueSeries.reduce((s, d) => s + d.revenueMinor, 0)
    : 0;

  const counts = {
    placed: active.filter((o) => o.status === 'PLACED').length,
    preparing: active.filter((o) => o.status === 'PREPARING').length,
    ready: active.filter((o) => o.status === 'READY').length,
  };

  const bestDay = series.reduce<(typeof series)[number] | null>(
    (best, d) => (d.revenueMinor > (best?.revenueMinor ?? 0) ? d : best),
    null,
  );

  const topInsight = insights[0];

  const dateLine = new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Asia/Kolkata',
  }).format(new Date());

  return (
    <div>
      {/* Greeting */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">
          {greeting()}
          {firstName ? `, ${firstName}` : ''}
        </h1>
        <p className="text-[13px] text-ink-2">{dateLine}</p>
      </div>

      {/* 1 · Business health */}
      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Revenue today"
          value={today.summary.revenueMinor}
          format={formatMinor}
          delta={revDelta}
          compare="vs yesterday"
          spark={series.map((d) => d.revenueMinor)}
        />
        <StatCard
          label="Orders today"
          value={today.summary.orders}
          format={String}
          delta={orderDelta}
          compare="vs yesterday"
          spark={series.map((d) => d.orders)}
        />
        <StatCard
          label="Average bill"
          value={today.summary.averageBillMinor}
          format={formatMinor}
          delta={avgDelta}
          compare="vs yesterday"
          spark={series.map(avgOf)}
        />
        {/* No per-day items series exists — no sparkline or delta rather than a fake one. */}
        <StatCard label="Items sold today" value={today.summary.itemsSold} format={String} />
      </div>

      {/* 2 · Hero revenue + 3 · Today's brief */}
      <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-semibold">Revenue</h2>
              {heroData ? (
                <p className="mt-0.5 text-[12px] text-ink-2">
                  {`${formatMinor(heroTotal)} · past ${RANGES.find((r) => r.key === range)!.label}`}
                </p>
              ) : (
                <Skeleton className="mt-1 h-3.5 w-40" />
              )}
            </div>
            <Segmented
              options={RANGES}
              value={range}
              onChange={(k) => setRange(k)}
            />
          </div>
          {coldStart ? (
            <EmptyState
              icon={Store}
              title="No sales yet"
              body="Your revenue trend appears here after the first order."
              action={
                <Link
                  href="/dashboard/pos"
                  className="inline-flex h-9 items-center rounded-lg bg-brand px-3.5 text-sm font-medium text-brand-ink"
                >
                  Take your first order
                </Link>
              }
            />
          ) : heroData ? (
            <AreaLine key={range} data={heroData.revenueSeries} height={280} />
          ) : (
            <div role="status" aria-busy="true" aria-label="Loading revenue">
              <Skeleton className="h-[280px]" />
            </div>
          )}
        </Card>

        <div className="space-y-3">
          <h2 className="text-label px-1">Today&apos;s brief</h2>
          {topInsight && (
            <BriefCard
              href="/dashboard/ai"
              icon={topInsight.severity === 'warning' ? AlertTriangle : Sparkles}
              iconCls={topInsight.severity === 'warning' ? 'text-warning-text' : 'text-ink-3'}
              title={topInsight.title}
              body={topInsight.detail}
            />
          )}
          {lowStock !== null && (
            <BriefCard
              href="/dashboard/inventory"
              icon={Package}
              iconCls={lowStock > 0 ? 'text-warning-text' : 'text-ink-3'}
              title={lowStock > 0 ? `${lowStock} ingredient${lowStock === 1 ? '' : 's'} low on stock` : 'Stock levels look fine'}
              body={lowStock > 0 ? 'Review and reorder before service.' : 'Nothing under its reorder level right now.'}
            />
          )}
          <BriefCard
            href="/dashboard/kitchen"
            icon={ChefHat}
            iconCls={counts.ready > 0 ? 'text-success-text' : 'text-ink-3'}
            title={
              active.length === 0
                ? 'Kitchen is clear'
                : `${counts.placed + counts.preparing} in progress · ${counts.ready} ready`
            }
            body={active.length === 0 ? 'No active orders on the board.' : 'Open the live board.'}
          />
          {bestDay && (
            <BriefCard
              href="/dashboard/analytics"
              icon={TrendingUp}
              iconCls="text-ink-3"
              title={`Best day this week: ${new Date(`${bestDay.date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' })} · ${formatMinorCompact(bestDay.revenueMinor)}`}
              body="See what drove it in Analytics."
            />
          )}
        </div>
      </div>

      {/* Quick actions */}
      <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-6">
        {QUICK_ACTIONS.map((a) => (
          <Link
            key={a.href + a.label}
            href={a.href}
            className="group flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-[13px] font-medium transition-[border-color,transform] duration-120 hover:-translate-y-px hover:border-line-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
          >
            <a.icon aria-hidden className="size-4 shrink-0 text-ink-3 transition-colors duration-120 group-hover:text-ink" />
            <span className="truncate">{a.label}</span>
          </Link>
        ))}
      </div>

      {/* 5 · Detail: hours, top items, payments, live activity */}
      <div className="mt-4 grid items-start gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader title="Today by hour" />
          {today.peakHours.every((h) => h.orders === 0) ? (
            <p className="py-8 text-center text-[13px] text-ink-3">No orders yet today.</p>
          ) : (
            <Bars
              data={today.peakHours.map((h) => ({ label: hourLabel(h.hour), value: h.orders }))}
              height={170}
            />
          )}
        </Card>

        <Card>
          <CardHeader title="Today's top items" />
          {today.topProducts.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-ink-3">
              Sales appear here as orders come in.
            </p>
          ) : (
            <RowBars
              rows={today.topProducts.slice(0, 5).map((p) => ({
                label: p.name,
                value: p.revenueMinor,
                display: formatMinorCompact(p.revenueMinor),
                hint: `${p.quantity} sold`,
              }))}
            />
          )}
        </Card>

        <Card>
          <CardHeader title="Payments today" />
          {today.paymentBreakdown.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-ink-3">
              Payment methods break down here after the first sale.
            </p>
          ) : (
            <RowBars
              rows={today.paymentBreakdown.map((p) => ({
                label: p.method,
                value: p.amountMinor,
                display: formatMinorCompact(p.amountMinor),
                hint: `${p.count} order${p.count === 1 ? '' : 's'}`,
              }))}
            />
          )}
        </Card>

        <Card>
          <CardHeader
            title="Live activity"
            action={
              <span className="flex items-center gap-1.5 text-[11px] text-ink-3">
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    live ? 'bg-success' : 'bg-ink-3',
                  )}
                />
                {live ? 'Live' : 'Connecting'}
              </span>
            }
          />
          {feed.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-ink-3">
              Order events appear here as they happen.
            </p>
          ) : (
            <ul className="space-y-1">
              {feed.map((f) => (
                <li
                  key={f.uid}
                  className="flex animate-fade-up items-center gap-2.5 rounded-lg px-1 py-1.5 text-[13px]"
                >
                  <f.icon aria-hidden className="size-4 shrink-0 text-ink-3" />
                  <span className="min-w-0 truncate">{f.text}</span>
                  <time className="ml-auto shrink-0 text-[11px] text-ink-3 tabular-nums">
                    {f.at.toLocaleTimeString('en-IN', {
                      hour: '2-digit',
                      minute: '2-digit',
                      timeZone: 'Asia/Kolkata',
                    })}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/** One actionable brief row: icon, claim, one-line context, chevron. */
function BriefCard({
  href,
  icon: Icon,
  iconCls,
  title,
  body,
}: {
  href: string;
  icon: LucideIcon;
  iconCls: string;
  title: string;
  body: string;
}) {
  return (
    <Link href={href} className="block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current">
      <Card dense hover className="group flex items-start gap-3">
        <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', iconCls)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{title}</span>
          <span className="mt-0.5 line-clamp-2 block text-[12px] text-ink-2">{body}</span>
        </span>
        <ChevronRight
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-ink-3 transition-transform duration-120 group-hover:translate-x-0.5"
        />
      </Card>
    </Link>
  );
}
