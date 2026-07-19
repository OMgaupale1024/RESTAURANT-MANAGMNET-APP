'use client';

import { useSize } from '@/lib/use-size';

/**
 * 40px trend hint for StatCards. No axes, no tooltip, no legend — the card's
 * value is the number; this only shows shape. Series slot 1 always.
 */
export function Sparkline({ values, height = 40 }: { values: number[]; height?: number }) {
  const [ref, width] = useSize<HTMLDivElement>();

  if (values.length < 2) return <div ref={ref} style={{ height }} />;

  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const y = (v: number) => height - 3 - (v / max) * (height - 6);
  const pts = values.map((v, i) => `${i * step},${y(v)}`).join(' ');
  const area = `0,${height} ${pts} ${width},${height}`;

  return (
    <div ref={ref} className="w-full" style={{ height }}>
      {width > 0 && (
        <svg
          aria-hidden
          width={width}
          height={height}
          className="block overflow-visible"
          style={{ animation: 'chart-fade 400ms var(--ease-out-quart) both' }}
        >
          <polygon points={area} fill="var(--series-1)" opacity={0.08} />
          <polyline
            points={pts}
            fill="none"
            stroke="var(--series-1)"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}
    </div>
  );
}
