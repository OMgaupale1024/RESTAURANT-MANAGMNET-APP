'use client';

import { useState } from 'react';
import { useSize } from '@/lib/use-size';

export type Bar = { label: string; value: number };

const PAD = { top: 16, bottom: 20 };

/**
 * Vertical bars (hourly sales). Single series → slot 1, no legend. Bars grow
 * from the baseline (scaleY), staggered; the peak bar is direct-labeled;
 * every bar gets a hover tooltip. Labels thinned to fit.
 */
export function Bars({ data, height = 180, format = String }: {
  data: Bar[];
  height?: number;
  format?: (v: number) => string;
}) {
  const [ref, width] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  if (data.length === 0) return <div ref={ref} style={{ height }} />;

  const plotH = height - PAD.top - PAD.bottom;
  const max = Math.max(...data.map((d) => d.value), 1);
  const step = width / data.length;
  const barW = Math.max(3, Math.min(28, step - 2));
  const peak = data.reduce((p, d, i) => (d.value > data[p].value ? i : p), 0);
  const tickEvery = Math.max(1, Math.ceil(data.length / 8));
  const h = hover === null ? null : data[hover];

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${data.length} bars, peak ${format(data[peak].value)} at ${data[peak].label}`}
          className="block"
          onMouseLeave={() => setHover(null)}
        >
          <line
            x1={0}
            x2={width}
            y1={PAD.top + plotH}
            y2={PAD.top + plotH}
            stroke="var(--line-2)"
          />
          {data.map((d, i) => {
            const barH = Math.max(d.value > 0 ? 2 : 0, (d.value / max) * plotH);
            const cx = i * step + step / 2;
            return (
              <g key={d.label}>
                {/* Oversized hit target so thin bars are hoverable */}
                <rect
                  x={i * step}
                  y={0}
                  width={step}
                  height={height}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                />
                <rect
                  x={cx - barW / 2}
                  y={PAD.top + plotH - barH}
                  width={barW}
                  height={barH}
                  rx={Math.min(4, barW / 2)}
                  fill="var(--series-1)"
                  opacity={hover === null || hover === i ? 1 : 0.45}
                  style={{
                    transformBox: 'fill-box',
                    transformOrigin: 'bottom',
                    animation: `bar-grow-y 300ms var(--ease-out-quart) ${Math.min(i * 12, 240)}ms both`,
                    transition: 'opacity 120ms',
                  }}
                />
                {i === peak && d.value > 0 && (
                  <text
                    x={cx}
                    y={PAD.top + plotH - barH - 6}
                    textAnchor="middle"
                    className="fill-ink-2 text-[10px] font-medium tabular-nums"
                  >
                    {format(d.value)}
                  </text>
                )}
                {i % tickEvery === 0 && (
                  <text
                    x={cx}
                    y={height - 6}
                    textAnchor="middle"
                    className="fill-ink-3 text-[10px]"
                  >
                    {d.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}

      {h && hover !== null && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-line bg-surface px-2.5 py-1.5 shadow-[0_4px_16px_rgb(0_0_0/0.08)]"
          style={{
            left: Math.max(48, Math.min(width - 48, hover * step + step / 2)),
            top: 0,
          }}
        >
          <p className="text-[11px] whitespace-nowrap">
            <span className="text-ink-3">{h.label} · </span>
            <span className="font-medium tabular-nums">{format(h.value)}</span>
          </p>
        </div>
      )}
    </div>
  );
}
