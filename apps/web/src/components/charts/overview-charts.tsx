'use client';

import type { SalesReport } from '@/lib/api';
import { formatMinorCompact } from '@/lib/money';
import { hourLabel } from '@/lib/series';
import { AreaLine } from './area-line';
import { Bars } from './bars';
import { RowBars } from './row-bars';
import { Card, CardHeader } from '@/components/ui/card';

/**
 * The sales-breakdown chart grid shared by Analytics and Reports. Trend lines
 * appear only when the window spans multiple days; a single-day window leads
 * with the hourly profile instead. Callers handle the true cold start (zero
 * orders) — this renders real data only. `chartKey` re-mounts the charts so
 * entrance animations replay on a window change, never on unrelated renders.
 */
export function OverviewCharts({ data, chartKey }: { data: SalesReport; chartKey: string }) {
  const series = data.revenueSeries;
  const trend = series.length >= 2;
  const payTotal = data.paymentBreakdown.reduce((s, p) => s + p.amountMinor, 0);

  return (
    <div className="grid items-start gap-4 lg:grid-cols-3">
      {trend && (
        <>
          <Card className="lg:col-span-2">
            <CardHeader title="Revenue trend" />
            <AreaLine key={chartKey} data={series} height={260} />
          </Card>
          <Card>
            <CardHeader title="Orders trend" />
            <AreaLine key={chartKey} data={series} metric="orders" height={260} />
          </Card>
        </>
      )}

      <Card className={trend ? undefined : 'lg:col-span-2'}>
        <CardHeader title="Orders by hour" />
        {data.peakHours.every((h) => h.orders === 0) ? (
          <p className="py-8 text-center text-[13px] text-ink-3">No orders in this window.</p>
        ) : (
          <Bars
            key={chartKey}
            data={data.peakHours.map((h) => ({ label: hourLabel(h.hour), value: h.orders }))}
            height={180}
          />
        )}
      </Card>

      <Card>
        <CardHeader title="Top items" />
        {data.topProducts.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-ink-3">No items sold in this window.</p>
        ) : (
          <RowBars
            key={chartKey}
            rows={data.topProducts.slice(0, 8).map((p) => ({
              label: p.name,
              value: p.revenueMinor,
              display: formatMinorCompact(p.revenueMinor),
              hint: `${p.quantity} sold`,
            }))}
          />
        )}
      </Card>

      <Card>
        <CardHeader title="Payments" />
        {payTotal === 0 ? (
          <p className="py-8 text-center text-[13px] text-ink-3">No payments in this window.</p>
        ) : (
          <RowBars
            key={chartKey}
            rows={data.paymentBreakdown.map((p) => ({
              label: p.method,
              value: p.amountMinor,
              display: formatMinorCompact(p.amountMinor),
              hint: `${p.count} · ${Math.round((p.amountMinor / payTotal) * 100)}%`,
            }))}
          />
        )}
      </Card>
    </div>
  );
}
