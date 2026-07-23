'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { BarChart3, Clock, Download, TrendingDown, TrendingUp } from 'lucide-react';
import {
  ApiRequestError,
  getAnalytics,
  getSalesReport,
  type SalesReport,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { downloadSalesCsv } from '@/lib/csv';
import { formatMinor, formatMinorCompact } from '@/lib/money';
import {
  addDays,
  daysBetween,
  fillSeries,
  hourLabel,
  isoDate,
  istDay,
  pctDelta,
} from '@/lib/series';
import { OverviewCharts } from '@/components/charts/overview-charts';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'custom', label: 'Custom' },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

/** A loaded window plus everything derived from it, gated by its own key. */
type Loaded = {
  key: string;
  data: SalesReport;
  /** Server summary of the same-length window immediately before; null = no comparison. */
  prev: SalesReport['summary'] | null;
  fromDay: string;
  toDay: string;
  days: number;
};

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

export function AnalyticsClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);

  const [range, setRange] = useState<RangeKey>('7d');
  const [today] = useState(() => isoDate(new Date()));
  const [customFrom, setCustomFrom] = useState(() =>
    isoDate(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)),
  );
  const [customTo, setCustomTo] = useState(() => isoDate(new Date()));
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  const windowKey = range === 'custom' ? `custom:${customFrom}_${customTo}` : range;
  const rangeError =
    range === 'custom' && customFrom > customTo
      ? 'Start date must not be after end date.'
      : null;

  useEffect(() => {
    if (!accessToken || rangeError) return;
    let cancelled = false;
    void (async () => {
      try {
        setError(null);
        const raw =
          range === 'custom'
            ? await getSalesReport(accessToken, onNewToken, customFrom, customTo)
            : await getAnalytics(accessToken, onNewToken, range);
        const data = fillSeries(raw);
        const fromDay = istDay(data.from);
        const toDay = istDay(data.to);
        const days = daysBetween(fromDay, toDay);
        // Previous same-length window, aggregated by the same server code. If
        // it fails, show no comparison rather than a wrong one.
        let prev: SalesReport['summary'] | null = null;
        try {
          const p = await getSalesReport(
            accessToken,
            onNewToken,
            addDays(fromDay, -days),
            addDays(fromDay, -1),
          );
          prev = p.summary;
        } catch {
          prev = null;
        }
        if (!cancelled) {
          setLoaded({ key: range === 'custom' ? `custom:${customFrom}_${customTo}` : range, data, prev, fromDay, toDay, days });
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiRequestError ? e.message : 'Could not load analytics');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, range, customFrom, customTo, rangeError]);

  // A stale window is never shown under a fresh label — skeleton instead.
  const view = loaded && loaded.key === windowKey ? loaded : null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented options={RANGES} value={range} onChange={setRange} />
          <Button
            variant="secondary"
            size="md"
            disabled={!view || view.data.revenueSeries.length === 0}
            onClick={() =>
              view && downloadSalesCsv(view.data.revenueSeries, view.fromDay, view.toDay)
            }
          >
            <Download aria-hidden className="size-4" />
            Export CSV
          </Button>
        </div>
      </div>

      {range === 'custom' && (
        <div className="mt-4 flex animate-fade-up flex-wrap items-end gap-3">
          <label className="block">
            <span className="text-label mb-1.5 block">From</span>
            <Input
              type="date"
              value={customFrom}
              max={customTo}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="w-40"
            />
          </label>
          <label className="block">
            <span className="text-label mb-1.5 block">To</span>
            <Input
              type="date"
              value={customTo}
              min={customFrom}
              max={today}
              onChange={(e) => setCustomTo(e.target.value)}
              className="w-40"
            />
          </label>
          {rangeError && (
            <p role="alert" className="pb-2 text-[13px] text-danger-text">
              {rangeError}
            </p>
          )}
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-text"
        >
          {error}
        </p>
      )}

      {!view ? (
        !error &&
        !rangeError && (
          <div role="status" aria-busy="true" aria-label="Loading analytics">
            <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-36" />
              ))}
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <Skeleton className="h-80 lg:col-span-2" />
              <Skeleton className="h-80" />
            </div>
          </div>
        )
      ) : (
        <AnalyticsBody view={view} rangeKey={range} />
      )}
    </div>
  );
}

function AnalyticsBody({ view, rangeKey }: { view: Loaded; rangeKey: RangeKey }) {
  const { data, prev, days } = view;
  const series = data.revenueSeries;
  // Sparklines only when there is a real shape to show — a flat zero line
  // under ₹0.00 reads as decoration, not data.
  const trend = series.length >= 2 && data.summary.orders > 0;
  const compare =
    prev === null ? undefined : rangeKey === 'today' ? 'vs yesterday' : `vs previous ${days} days`;
  const avgOf = (p: { revenueMinor: number; orders: number }) =>
    p.orders > 0 ? p.revenueMinor / p.orders : 0;
  const topSeller = data.topProducts[0];

  const best = trend ? series.reduce((a, b) => (b.revenueMinor > a.revenueMinor ? b : a)) : null;
  const slow = trend ? series.reduce((a, b) => (b.revenueMinor <= a.revenueMinor ? b : a)) : null;
  const peak = data.peakHours.reduce((a, b) => (b.orders > a.orders ? b : a));

  return (
    <div>
      {/* KPIs vs the previous window (server-aggregated both sides) */}
      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Revenue"
          value={data.summary.revenueMinor}
          format={formatMinor}
          delta={prev ? pctDelta(data.summary.revenueMinor, prev.revenueMinor) : undefined}
          compare={compare}
          spark={trend ? series.map((d) => d.revenueMinor) : undefined}
        />
        <StatCard
          label="Orders"
          value={data.summary.orders}
          format={String}
          delta={prev ? pctDelta(data.summary.orders, prev.orders) : undefined}
          compare={compare}
          spark={trend ? series.map((d) => d.orders) : undefined}
        />
        <StatCard
          label="Average bill"
          value={data.summary.averageBillMinor}
          format={formatMinor}
          delta={prev ? pctDelta(data.summary.averageBillMinor, prev.averageBillMinor) : undefined}
          compare={compare}
          spark={trend ? series.map(avgOf) : undefined}
        />
        <Card className="min-w-0">
          <p className="text-label">Top seller</p>
          {topSeller ? (
            <>
              <p className="mt-1.5 truncate text-[20px] leading-tight font-semibold tracking-tight">
                {topSeller.name}
              </p>
              <p className="mt-1 text-[12px] text-ink-2">
                {topSeller.quantity} sold ·{' '}
                <span className="tabular-nums">{formatMinor(topSeller.revenueMinor)}</span>
              </p>
            </>
          ) : (
            <p className="mt-1.5 text-[13px] text-ink-3">No sales in this window.</p>
          )}
        </Card>
      </div>

      {data.summary.orders === 0 ? (
        <Card className="mt-4">
          <EmptyState
            icon={BarChart3}
            title="No sales in this window"
            body="Charts light up as soon as orders land in this date range. Try a wider range, or take an order."
            action={
              <Link
                href="/dashboard/pos"
                className="inline-flex h-9 items-center rounded-lg bg-brand px-3.5 text-sm font-medium text-brand-ink"
              >
                Take an order
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          {/* What changed / what to investigate — all from the same real series */}
          {trend && (
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <InsightChip
                icon={TrendingUp}
                label="Best day"
                value={best ? `${dayLabel(best.date)} · ${formatMinorCompact(best.revenueMinor)}` : '—'}
              />
              <InsightChip
                icon={TrendingDown}
                label="Slowest day"
                value={slow ? `${dayLabel(slow.date)} · ${formatMinorCompact(slow.revenueMinor)}` : '—'}
              />
              <InsightChip
                icon={Clock}
                label="Busiest hour"
                value={
                  peak.orders > 0
                    ? `${hourLabel(peak.hour)}–${hourLabel((peak.hour + 1) % 24)} · ${peak.orders} orders`
                    : '—'
                }
              />
            </div>
          )}

          <div className="mt-4">
            <OverviewCharts data={data} chartKey={view.key} />
          </div>
        </>
      )}
    </div>
  );
}

function InsightChip({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof TrendingUp;
  label: string;
  value: string;
}) {
  return (
    <Card dense className="flex items-center gap-3">
      <Icon aria-hidden className="size-4 shrink-0 text-ink-3" />
      <div className="min-w-0">
        <p className="text-label">{label}</p>
        <p className="mt-0.5 truncate text-[13px] font-medium tabular-nums">{value}</p>
      </div>
    </Card>
  );
}
