'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { ApiRequestError, getSalesReport, type SalesReport } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { downloadSalesCsv } from '@/lib/csv';
import { formatMinor } from '@/lib/money';
import { fillSeries, isoDate } from '@/lib/series';
import { OverviewCharts } from '@/components/charts/overview-charts';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th, Tr } from '@/components/ui/table';

/** Named windows an owner actually asks for. Computed in local time on click. */
const PRESETS: Array<{ label: string; window: () => [Date, Date] }> = [
  {
    label: 'This week',
    window: () => {
      const from = new Date();
      from.setDate(from.getDate() - ((from.getDay() + 6) % 7)); // back to Monday
      return [from, new Date()];
    },
  },
  {
    label: 'This month',
    window: () => {
      const now = new Date();
      return [new Date(now.getFullYear(), now.getMonth(), 1), now];
    },
  },
  {
    label: 'Last month',
    window: () => {
      const now = new Date();
      return [
        new Date(now.getFullYear(), now.getMonth() - 1, 1),
        new Date(now.getFullYear(), now.getMonth(), 0),
      ];
    },
  },
];

export function ReportsClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);

  const [today] = useState(() => isoDate(new Date()));
  const [from, setFrom] = useState(() =>
    isoDate(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)),
  );
  const [to, setTo] = useState(() => isoDate(new Date()));
  const [loaded, setLoaded] = useState<{ key: string; data: SalesReport } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const windowKey = `${from}_${to}`;
  const rangeError = from > to ? 'Start date must not be after end date.' : null;

  useEffect(() => {
    if (!accessToken || from > to) return;
    let cancelled = false;
    void (async () => {
      try {
        setError(null);
        const d = await getSalesReport(accessToken, onNewToken, from, to);
        if (!cancelled) setLoaded({ key: `${from}_${to}`, data: fillSeries(d) });
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiRequestError ? e.message : 'Could not load report');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, from, to]);

  // Never show one window's numbers under another window's dates.
  const view = loaded && loaded.key === windowKey ? loaded.data : null;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
        <div className="flex flex-wrap items-end gap-2">
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              variant="ghost"
              size="sm"
              onClick={() => {
                const [f, t] = p.window();
                setFrom(isoDate(f));
                setTo(isoDate(t));
              }}
            >
              {p.label}
            </Button>
          ))}
          <label className="block">
            <span className="text-label mb-1.5 block">From</span>
            <Input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="w-40"
            />
          </label>
          <label className="block">
            <span className="text-label mb-1.5 block">To</span>
            <Input
              type="date"
              value={to}
              min={from}
              max={today}
              onChange={(e) => setTo(e.target.value)}
              className="w-40"
            />
          </label>
          <Button
            variant="secondary"
            disabled={!view || view.revenueSeries.length === 0}
            onClick={() => view && downloadSalesCsv(view.revenueSeries, from, to)}
          >
            <Download aria-hidden className="size-4" />
            Export CSV
          </Button>
        </div>
      </div>

      {(rangeError ?? error) && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-text"
        >
          {rangeError ?? error}
        </p>
      )}

      {rangeError ? null : !view ? (
        !error && (
          <div>
            <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-28" />
              ))}
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <Skeleton className="h-80 lg:col-span-2" />
              <Skeleton className="h-80" />
            </div>
          </div>
        )
      ) : (
        <div>
          <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Revenue" value={view.summary.revenueMinor} format={formatMinor} />
            <StatCard label="Orders" value={view.summary.orders} format={String} />
            <StatCard
              label="Average bill"
              value={view.summary.averageBillMinor}
              format={formatMinor}
            />
            <StatCard label="Items sold" value={view.summary.itemsSold} format={String} />
          </div>

          {view.summary.orders === 0 ? (
            <Card className="mt-4">
              <EmptyState
                icon={FileText}
                title="No sales in this window"
                body="Pick a different range, or take an order — the report fills in from real sales only."
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
              <div className="mt-4">
                <OverviewCharts data={view} chartKey={windowKey} />
              </div>

              <Card className="mt-4 p-2">
                <div className="px-3 pt-3">
                  <CardHeader title="Daily sales" />
                </div>
                <Table>
                  <thead>
                    <tr>
                      <Th>Date</Th>
                      <Th numeric>Orders</Th>
                      <Th numeric>Revenue</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.revenueSeries.map((d) => (
                      <Tr key={d.date}>
                        <Td className="tabular-nums">{d.date}</Td>
                        <Td numeric>{d.orders}</Td>
                        <Td numeric>{formatMinor(d.revenueMinor)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            </>
          )}
        </div>
      )}
    </div>
  );
}
