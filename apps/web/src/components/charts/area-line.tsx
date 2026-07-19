'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { formatMinor, formatMinorCompact } from '@/lib/money';
import { useSize } from '@/lib/use-size';

export type RevenuePoint = { date: string; revenueMinor: number; orders: number };

const PAD = { top: 12, right: 12, bottom: 24, left: 44 };

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * Revenue-over-time hero chart (DESIGN.md §4). Single series → slot 1, no
 * legend. Draw-in via pathLength/stroke-dashoffset; area fades in after.
 * Hover shows a crosshair + tooltip with revenue, orders, and average bill —
 * all derived from the same real points, nothing recomputed server-side.
 * Re-mount with a new `key` (e.g. the range) to re-run the entrance.
 */
export function AreaLine({
  data,
  height = 260,
  metric = 'revenue',
}: {
  data: RevenuePoint[];
  height?: number;
  /** Which field the line traces. The tooltip always shows both plus avg bill. */
  metric?: 'revenue' | 'orders';
}) {
  const [ref, width] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const val = (d: RevenuePoint) => (metric === 'orders' ? d.orders : d.revenueMinor);
  const fmt = metric === 'orders' ? (v: number) => String(Math.round(v)) : formatMinorCompact;

  if (data.length < 2) {
    return (
      <div ref={ref} className="flex items-center justify-center" style={{ height }}>
        <p className="text-[13px] text-ink-3">Not enough days to draw a trend yet.</p>
      </div>
    );
  }

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const max = Math.max(...data.map(val), 1) * 1.08;
  const x = (i: number) => PAD.left + (i / (data.length - 1)) * plotW;
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;

  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(val(d))}`).join('');
  const area = `${line}L${x(data.length - 1)},${PAD.top + plotH}L${x(0)},${PAD.top + plotH}Z`;

  // ~6 x labels; every point gets a hover column regardless.
  const tickEvery = Math.max(1, Math.ceil(data.length / 6));
  const gridLines = [1 / 3, 2 / 3, 1];

  const last = data[data.length - 1];
  const h = hover === null ? null : data[hover];
  const total = data.reduce((s, d) => s + val(d), 0);

  function onMove(e: React.MouseEvent) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left - PAD.left;
    const i = Math.round((px / Math.max(1, plotW)) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  }

  // Tooltip flips sides near the right edge.
  const tipLeft = hover !== null && x(hover) > width - 160;

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <>
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={
              metric === 'orders'
                ? `Orders by day, ${data.length} days, total ${total}`
                : `Revenue by day, ${data.length} days, total ${formatMinor(total)}`
            }
            className="block"
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {/* Grid + y labels */}
            {gridLines.map((g) => (
              <g key={g}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y(max * g)}
                  y2={y(max * g)}
                  stroke="var(--line)"
                />
                <text
                  x={PAD.left - 8}
                  y={y(max * g) + 3}
                  textAnchor="end"
                  className="fill-ink-3 text-[10px] tabular-nums"
                >
                  {fmt(max * g)}
                </text>
              </g>
            ))}
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={PAD.top + plotH}
              y2={PAD.top + plotH}
              stroke="var(--line-2)"
            />

            {/* X labels, thinned */}
            {data.map((d, i) =>
              i % tickEvery === 0 ? (
                <text
                  key={d.date}
                  x={x(i)}
                  y={height - 8}
                  textAnchor="middle"
                  className="fill-ink-3 text-[10px]"
                >
                  {d.date.slice(5).replace('-', '/')}
                </text>
              ) : null,
            )}

            {/* Area then line (drawn via pathLength trick) */}
            <path
              d={area}
              fill="var(--series-1)"
              style={{ animation: 'chart-fade 400ms var(--ease-out-quart) 200ms both', opacity: 0.08 }}
            />
            <path
              d={line}
              fill="none"
              stroke="var(--series-1)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              pathLength={1}
              strokeDasharray={1}
              style={{ animation: 'chart-draw 400ms var(--ease-out-quart) both' }}
            />

            {/* Direct label on the latest point */}
            <text
              x={x(data.length - 1)}
              y={y(val(last)) - 8}
              textAnchor="end"
              className="fill-ink-2 text-[11px] font-medium tabular-nums"
            >
              {fmt(val(last))}
            </text>

            {/* Crosshair + marker */}
            {h && hover !== null && (
              <g>
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={PAD.top}
                  y2={PAD.top + plotH}
                  stroke="var(--line-2)"
                />
                <circle
                  cx={x(hover)}
                  cy={y(val(h))}
                  r={4}
                  fill="var(--series-1)"
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              </g>
            )}
          </svg>

          {h && hover !== null && (
            <div
              className={cn(
                'pointer-events-none absolute z-10 w-[150px] rounded-lg border border-line bg-surface p-2.5 shadow-[0_4px_16px_rgb(0_0_0/0.08)]',
              )}
              style={{
                top: PAD.top,
                left: tipLeft ? x(hover) - 162 : x(hover) + 12,
              }}
            >
              <p className="text-[11px] font-medium">{fmtDate(h.date)}</p>
              <dl className="mt-1.5 space-y-1 text-[11px]">
                <TooltipRow label="Revenue" value={formatMinor(h.revenueMinor)} />
                <TooltipRow label="Orders" value={String(h.orders)} />
                <TooltipRow
                  label="Avg bill"
                  value={h.orders > 0 ? formatMinor(Math.round(h.revenueMinor / h.orders)) : '—'}
                />
              </dl>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-3">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
