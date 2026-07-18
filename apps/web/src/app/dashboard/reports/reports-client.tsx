'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, getSalesReport, type SalesReport } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatMinor } from '@/lib/money';

/** Local calendar day as YYYY-MM-DD, for the date inputs and the server window. */
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Builds a daily sales CSV and hands it to the browser to download.
 *
 * Only dates and numbers are exported — deliberately no product names, which
 * would need CSV-injection escaping (a name starting with "=" is a formula in
 * Excel). The daily revenue series is what an accountant actually pastes into
 * their books. Money is paise/100 to two decimals: safe from float drift
 * because it starts from an integer.
 */
function downloadCsv(report: SalesReport, from: string, to: string) {
  const header = 'Date,Orders,Revenue (INR)';
  const rows = report.revenueSeries.map(
    (d) => `${d.date},${d.orders},${(d.revenueMinor / 100).toFixed(2)}`,
  );
  const csv = [header, ...rows].join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sales-${from}_to_${to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportsClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);

  // Lazy initialisers so the clock is read once on mount, not every render.
  const [today] = useState(() => isoDate(new Date()));
  const [from, setFrom] = useState(() =>
    isoDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
  );
  const [to, setTo] = useState(() => isoDate(new Date()));
  const [data, setData] = useState<SalesReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Derived during render, not stored — a reversed range needs no effect.
  const rangeError = from > to ? 'Start date must not be after end date.' : null;

  useEffect(() => {
    if (!accessToken || from > to) return;
    let cancelled = false;
    void (async () => {
      try {
        const d = await getSalesReport(accessToken, onNewToken, from, to);
        if (!cancelled) {
          setData(d);
          setError(null);
        }
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

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-black/60 dark:text-white/60">
            From
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 block rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
            />
          </label>
          <label className="text-xs text-black/60 dark:text-white/60">
            To
            <input
              type="date"
              value={to}
              min={from}
              max={today}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 block rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
            />
          </label>
          <button
            type="button"
            disabled={!data || data.revenueSeries.length === 0}
            onClick={() => data && downloadCsv(data, from, to)}
            className="rounded-md border border-black/15 px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          >
            Export CSV
          </button>
        </div>
      </div>

      {(rangeError ?? error) && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          {rangeError ?? error}
        </p>
      )}

      {rangeError ? null : !data ? (
        !error && <p className="mt-6 text-sm text-black/60 dark:text-white/60">Loading…</p>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Revenue" value={formatMinor(data.summary.revenueMinor)} />
            <Stat label="Orders" value={String(data.summary.orders)} />
            <Stat label="Avg bill" value={formatMinor(data.summary.averageBillMinor)} />
            <Stat label="Items sold" value={String(data.summary.itemsSold)} />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <section
              aria-labelledby="daily-heading"
              className="rounded-lg border border-black/10 p-4 dark:border-white/15"
            >
              <h2 id="daily-heading" className="text-sm font-medium">
                Daily sales
              </h2>
              {data.revenueSeries.length === 0 ? (
                <p className="mt-3 text-sm text-black/50 dark:text-white/50">
                  No sales in this range.
                </p>
              ) : (
                <table className="mt-3 w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-black/50 dark:text-white/50">
                      <th className="font-normal">Date</th>
                      <th className="font-normal text-right">Orders</th>
                      <th className="font-normal text-right">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.revenueSeries.map((d) => (
                      <tr key={d.date}>
                        <td className="tabular-nums">{d.date}</td>
                        <td className="text-right tabular-nums">{d.orders}</td>
                        <td className="text-right tabular-nums">
                          {formatMinor(d.revenueMinor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section
              aria-labelledby="top-heading"
              className="rounded-lg border border-black/10 p-4 dark:border-white/15"
            >
              <h2 id="top-heading" className="text-sm font-medium">
                Top items
              </h2>
              {data.topProducts.length === 0 ? (
                <p className="mt-3 text-sm text-black/50 dark:text-white/50">No sales yet.</p>
              ) : (
                <ol className="mt-3 space-y-1 text-sm">
                  {data.topProducts.map((p) => (
                    <li key={p.name} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <span className="text-xs text-black/50 dark:text-white/50">×{p.quantity}</span>
                      <span className="w-20 text-right tabular-nums">
                        {formatMinor(p.revenueMinor)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section
              aria-labelledby="pay-heading"
              className="rounded-lg border border-black/10 p-4 dark:border-white/15"
            >
              <h2 id="pay-heading" className="text-sm font-medium">
                Payment methods
              </h2>
              {data.paymentBreakdown.length === 0 ? (
                <p className="mt-3 text-sm text-black/50 dark:text-white/50">No payments yet.</p>
              ) : (
                <ul className="mt-3 space-y-1 text-sm">
                  {data.paymentBreakdown.map((p) => (
                    <li key={p.method} className="flex items-center justify-between gap-2">
                      <span>
                        {p.method.charAt(0) + p.method.slice(1).toLowerCase()}
                        <span className="ml-1 text-xs text-black/50 dark:text-white/50">
                          ({p.count})
                        </span>
                      </span>
                      <span className="tabular-nums">{formatMinor(p.amountMinor)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 p-4 dark:border-white/15">
      <dt className="text-xs text-black/60 dark:text-white/60">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
