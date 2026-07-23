'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import {
  ApiRequestError,
  getCategorySales,
  getDiscountReport,
  getGstReport,
  getItemSales,
  getSalesReport,
  getSettlementReport,
  getVoidReport,
  type SalesReport,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { downloadCsv, downloadSalesCsv, minorToCsv, toCsv } from '@/lib/csv';
import { formatMinor } from '@/lib/money';
import { fillSeries, isoDate } from '@/lib/series';
import { PAYMENT_LABEL } from '../orders/order-detail';
import { OverviewCharts } from '@/components/charts/overview-charts';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th, Tr } from '@/components/ui/table';

const REPORTS = [
  { key: 'sales', label: 'Sales' },
  { key: 'gst', label: 'GST' },
  { key: 'items', label: 'Items' },
  { key: 'categories', label: 'Categories' },
  { key: 'settlement', label: 'Settlement' },
  { key: 'voids', label: 'Voids' },
  { key: 'discounts', label: 'Discounts' },
] as const;
type ReportKey = (typeof REPORTS)[number]['key'];

/** Named windows an owner actually asks for. Computed in local time on click. */
const PRESETS: Array<{ label: string; window: () => [Date, Date] }> = [
  {
    label: 'This week',
    window: () => {
      const from = new Date();
      from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
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

const pct = (bp: number) => `${bp / 100}%`;

export function ReportsClient() {
  const [report, setReport] = useState<ReportKey>('sales');
  const [today] = useState(() => isoDate(new Date()));
  const [from, setFrom] = useState(() =>
    isoDate(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)),
  );
  const [to, setTo] = useState(() => isoDate(new Date()));

  const rangeError = from > to ? 'Start date must not be after end date.' : null;

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
        </div>
      </div>

      <div className="mt-4 overflow-x-auto">
        <Segmented options={REPORTS} value={report} onChange={setReport} />
      </div>

      {rangeError ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-text"
        >
          {rangeError}
        </p>
      ) : report === 'sales' ? (
        <SalesView from={from} to={to} />
      ) : (
        <TableReport key={report} report={report} from={from} to={to} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ sales */

function SalesView({ from, to }: { from: string; to: string }) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);

  const [loaded, setLoaded] = useState<{ key: string; data: SalesReport } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const windowKey = `${from}_${to}`;

  useEffect(() => {
    if (!accessToken) return;
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

  const view = loaded && loaded.key === windowKey ? loaded.data : null;

  if (error) {
    return <ErrorBox message={error} />;
  }
  if (!view) return <LoadingBlock />;

  return (
    <div>
      <div className="mt-5 flex justify-end">
        <Button
          variant="secondary"
          disabled={view.revenueSeries.length === 0}
          onClick={() => downloadSalesCsv(view.revenueSeries, from, to)}
        >
          <Download aria-hidden className="size-4" />
          Export CSV
        </Button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Revenue" value={view.summary.revenueMinor} format={formatMinor} />
        <StatCard label="Orders" value={view.summary.orders} format={String} />
        <StatCard label="Average bill" value={view.summary.averageBillMinor} format={formatMinor} />
        <StatCard label="Items sold" value={view.summary.itemsSold} format={String} />
      </div>

      {view.summary.orders === 0 ? (
        <NoSales />
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
  );
}

/* ------------------------------------------------- generic table reports */

type Loaded = {
  headers: string[];
  numericFrom: number; // index at which columns are right-aligned/numeric
  rows: Array<Array<string | number>>;
  csv: { headers: string[]; rows: Array<Array<string | number>> };
  footer?: Array<string | number>;
  empty: string;
};

function TableReport({
  report,
  from,
  to,
}: {
  report: Exclude<ReportKey, 'sales'>;
  from: string;
  to: string;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);

  const [loaded, setLoaded] = useState<{ key: string; view: Loaded } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const windowKey = `${report}_${from}_${to}`;

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void (async () => {
      try {
        setError(null);
        const view = await buildReport(report, accessToken, onNewToken, from, to);
        if (!cancelled) setLoaded({ key: windowKey, view });
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiRequestError ? e.message : 'Could not load report');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, report, from, to, windowKey]);

  if (error) return <ErrorBox message={error} />;
  const view = loaded && loaded.key === windowKey ? loaded.view : null;
  if (!view) return <LoadingBlock />;

  return (
    <div>
      <div className="mt-5 flex justify-end">
        <Button
          variant="secondary"
          disabled={view.rows.length === 0}
          onClick={() =>
            downloadCsv(
              `${report}-${from}_to_${to}.csv`,
              toCsv(view.csv.headers, view.csv.rows),
            )
          }
        >
          <Download aria-hidden className="size-4" />
          Export CSV
        </Button>
      </div>

      <Card className="mt-3 p-2">
        {view.rows.length === 0 ? (
          <EmptyState icon={FileText} title="Nothing to report" body={view.empty} />
        ) : (
          <Table>
            <thead>
              <tr>
                {view.headers.map((h, i) => (
                  <Th key={h} numeric={i >= view.numericFrom}>
                    {h}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row, ri) => (
                <Tr key={ri}>
                  {row.map((cell, ci) => (
                    <Td key={ci} numeric={ci >= view.numericFrom}>
                      {cell}
                    </Td>
                  ))}
                </Tr>
              ))}
              {view.footer && (
                <Tr>
                  {view.footer.map((cell, ci) => (
                    <Td key={ci} numeric={ci >= view.numericFrom} className="font-semibold">
                      {cell}
                    </Td>
                  ))}
                </Tr>
              )}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

async function buildReport(
  report: Exclude<ReportKey, 'sales'>,
  token: string,
  onNewToken: (t: string) => void,
  from: string,
  to: string,
): Promise<Loaded> {
  switch (report) {
    case 'gst': {
      const d = await getGstReport(token, onNewToken, from, to);
      return {
        headers: ['Rate', 'Taxable value', 'GST'],
        numericFrom: 1,
        rows: d.rows.map((r) => [
          pct(r.taxRateBp),
          formatMinor(r.taxableMinor),
          formatMinor(r.taxMinor),
        ]),
        footer: ['Total', formatMinor(d.totalTaxableMinor), formatMinor(d.totalTaxMinor)],
        csv: {
          headers: ['Rate (%)', 'Taxable (INR)', 'GST (INR)'],
          rows: d.rows.map((r) => [
            r.taxRateBp / 100,
            minorToCsv(r.taxableMinor),
            minorToCsv(r.taxMinor),
          ]),
        },
        empty: 'No taxable sales in this window.',
      };
    }
    case 'items': {
      const d = await getItemSales(token, onNewToken, from, to);
      return {
        headers: ['Item', 'Qty', 'Revenue'],
        numericFrom: 1,
        rows: d.rows.map((r) => [r.name, r.quantity, formatMinor(r.revenueMinor)]),
        csv: {
          headers: ['Item', 'Quantity', 'Revenue (INR)'],
          rows: d.rows.map((r) => [r.name, r.quantity, minorToCsv(r.revenueMinor)]),
        },
        empty: 'No items sold in this window.',
      };
    }
    case 'categories': {
      const d = await getCategorySales(token, onNewToken, from, to);
      return {
        headers: ['Category', 'Qty', 'Revenue'],
        numericFrom: 1,
        rows: d.rows.map((r) => [r.category, r.quantity, formatMinor(r.revenueMinor)]),
        csv: {
          headers: ['Category', 'Quantity', 'Revenue (INR)'],
          rows: d.rows.map((r) => [r.category, r.quantity, minorToCsv(r.revenueMinor)]),
        },
        empty: 'No sales in this window.',
      };
    }
    case 'settlement': {
      const d = await getSettlementReport(token, onNewToken, from, to);
      return {
        headers: ['Method', 'Orders', 'Captured', 'Refunded', 'Net'],
        numericFrom: 1,
        rows: d.rows.map((r) => [
          PAYMENT_LABEL[r.method] ?? r.method,
          r.count,
          formatMinor(r.capturedMinor),
          formatMinor(r.refundedMinor),
          formatMinor(r.netMinor),
        ]),
        footer: [
          'Total',
          '',
          formatMinor(d.totalCapturedMinor),
          formatMinor(d.totalRefundedMinor),
          formatMinor(d.totalNetMinor),
        ],
        csv: {
          headers: ['Method', 'Orders', 'Captured (INR)', 'Refunded (INR)', 'Net (INR)'],
          rows: d.rows.map((r) => [
            r.method,
            r.count,
            minorToCsv(r.capturedMinor),
            minorToCsv(r.refundedMinor),
            minorToCsv(r.netMinor),
          ]),
        },
        empty: 'No payments taken in this window.',
      };
    }
    case 'voids': {
      const d = await getVoidReport(token, onNewToken, from, to);
      return {
        headers: ['Order', 'Status', 'Amount', 'Reason', 'When'],
        numericFrom: 2,
        rows: d.rows.map((r) => [
          `#${r.orderNumber}`,
          r.status === 'VOIDED' ? 'Voided' : 'Cancelled',
          formatMinor(r.totalMinor),
          r.reason ?? '—',
          new Date(r.at).toLocaleString('en-IN', {
            day: 'numeric',
            month: 'short',
            hour: 'numeric',
            minute: '2-digit',
          }),
        ]),
        footer: [`${d.count} orders`, '', formatMinor(d.totalMinor), '', ''],
        csv: {
          headers: ['Order', 'Status', 'Amount (INR)', 'Reason', 'When (ISO)'],
          rows: d.rows.map((r) => [
            r.orderNumber,
            r.status,
            minorToCsv(r.totalMinor),
            r.reason ?? '',
            r.at,
          ]),
        },
        empty: 'No voided or cancelled orders in this window — good.',
      };
    }
    case 'discounts': {
      const d = await getDiscountReport(token, onNewToken, from, to);
      return {
        headers: ['Order', 'Coupon', 'Subtotal', 'Discount', 'Total'],
        numericFrom: 2,
        rows: d.rows.map((r) => [
          `#${r.orderNumber}`,
          r.couponCode ?? '—',
          formatMinor(r.subtotalMinor),
          `−${formatMinor(r.discountMinor)}`,
          formatMinor(r.totalMinor),
        ]),
        footer: [`${d.count} orders`, '', '', `−${formatMinor(d.totalDiscountMinor)}`, ''],
        csv: {
          headers: ['Order', 'Coupon', 'Subtotal (INR)', 'Discount (INR)', 'Total (INR)'],
          rows: d.rows.map((r) => [
            r.orderNumber,
            r.couponCode ?? '',
            minorToCsv(r.subtotalMinor),
            minorToCsv(r.discountMinor),
            minorToCsv(r.totalMinor),
          ]),
        },
        empty: 'No discounts given in this window.',
      };
    }
  }
}

/* --------------------------------------------------------------- shared */

function LoadingBlock() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading report">
      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="mt-4 h-80" />
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-text"
    >
      {message}
    </p>
  );
}

function NoSales() {
  return (
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
  );
}
