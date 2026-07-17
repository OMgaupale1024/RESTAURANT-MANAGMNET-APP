'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiRequestError,
  getAnalytics,
  type AnalyticsOverview,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatMinor } from '@/lib/money';

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
] as const;

export function AnalyticsClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);

  const [range, setRange] = useState('7d');
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const d = await getAnalytics(accessToken, onNewToken, range);
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiRequestError ? e.message : 'Could not load analytics');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, range]);

  const maxHour = data ? Math.max(1, ...data.peakHours.map((h) => h.orders)) : 1;
  const maxDay = data
    ? Math.max(1, ...data.revenueSeries.map((d) => d.revenueMinor))
    : 1;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              aria-pressed={range === r.key}
              className={`rounded-md px-3 py-1.5 text-sm ${range === r.key ? 'bg-black/10 font-medium dark:bg-white/15' : 'hover:bg-black/5 dark:hover:bg-white/10'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      )}

      {!data ? (
        <p className="mt-6 text-sm text-black/60 dark:text-white/60">Loading…</p>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Revenue" value={formatMinor(data.summary.revenueMinor)} />
            <Stat label="Orders" value={String(data.summary.orders)} />
            <Stat label="Avg bill" value={formatMinor(data.summary.averageBillMinor)} />
            <Stat label="Items sold" value={String(data.summary.itemsSold)} />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            {/* Revenue per day */}
            <section
              aria-labelledby="rev-heading"
              className="rounded-lg border border-black/10 p-4 dark:border-white/15"
            >
              <h2 id="rev-heading" className="text-sm font-medium">
                Revenue per day
              </h2>
              {data.revenueSeries.length === 0 ? (
                <p className="mt-3 text-sm text-black/50 dark:text-white/50">No sales yet.</p>
              ) : (
                <ul className="mt-3 space-y-1">
                  {data.revenueSeries.map((d) => (
                    <li key={d.date} className="flex items-center gap-2 text-xs">
                      <span className="w-16 shrink-0 text-black/50 tabular-nums dark:text-white/50">
                        {d.date.slice(5)}
                      </span>
                      <span
                        className="h-3 rounded-sm bg-brand"
                        style={{ width: `${Math.max(4, (d.revenueMinor / maxDay) * 100)}%` }}
                        aria-hidden
                      />
                      <span className="ml-auto tabular-nums">{formatMinor(d.revenueMinor)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Top products */}
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
                      <span className="text-xs text-black/50 dark:text-white/50">
                        ×{p.quantity}
                      </span>
                      <span className="w-20 text-right tabular-nums">
                        {formatMinor(p.revenueMinor)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {/* Payment methods */}
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

            {/* Peak hours */}
            <section
              aria-labelledby="hours-heading"
              className="rounded-lg border border-black/10 p-4 dark:border-white/15"
            >
              <h2 id="hours-heading" className="text-sm font-medium">
                Orders by hour
              </h2>
              <div className="mt-3 flex h-24 items-end gap-0.5" aria-hidden>
                {data.peakHours.map((h) => (
                  <div
                    key={h.hour}
                    title={`${h.hour}:00 — ${h.orders} orders`}
                    className="flex-1 rounded-t-sm bg-brand"
                    style={{ height: `${Math.max(2, (h.orders / maxHour) * 100)}%` }}
                  />
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-black/40 dark:text-white/40">
                <span>0h</span>
                <span>12h</span>
                <span>23h</span>
              </div>
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
