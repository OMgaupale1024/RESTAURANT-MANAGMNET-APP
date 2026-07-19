'use client';

import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { useCountUp } from '@/lib/use-count-up';
import { cn } from '@/lib/cn';
import { Card } from './card';
import { Sparkline } from '@/components/charts/sparkline';

/**
 * KPI tile (DESIGN.md §4): label, counted-up value, optional trend vs a
 * stated comparison, optional sparkline. Monochrome; the delta text is the
 * only colored element, and it never carries meaning by color alone (arrow
 * icon + signed number).
 */
export function StatCard({
  label,
  value,
  format,
  delta,
  compare,
  spark,
}: {
  label: string;
  value: number;
  format: (v: number) => string;
  /** Fractional change vs the comparison period, e.g. 0.12 = +12%. */
  delta?: number | null;
  /** What the delta compares against, e.g. "vs yesterday". */
  compare?: string;
  spark?: number[];
}) {
  const counted = useCountUp(value);

  return (
    <Card className="min-w-0">
      <p className="text-label">{label}</p>
      <p className="mt-1.5 text-[28px] leading-tight font-semibold tracking-tight tabular-nums">
        {format(counted)}
      </p>
      {delta !== undefined && (
        <p className="mt-1 flex items-center gap-1 text-[12px]">
          {delta === null ? (
            // Comparison not computable (e.g. divide-by-zero yesterday) — say
            // nothing rather than implying flatness.
            <Minus aria-hidden className="size-3 text-ink-3" />
          ) : delta === 0 ? (
            <>
              <Minus aria-hidden className="size-3 text-ink-3" />
              <span className="text-ink-3">no change</span>
            </>
          ) : delta > 0 ? (
            <>
              <ArrowUpRight aria-hidden className="size-3 text-success-text" />
              <span className="font-medium text-success-text tabular-nums">
                +{Math.round(delta * 100)}%
              </span>
            </>
          ) : (
            <>
              <ArrowDownRight aria-hidden className="size-3 text-danger-text" />
              <span className="font-medium text-danger-text tabular-nums">
                {Math.round(delta * 100)}%
              </span>
            </>
          )}
          {compare && <span className="text-ink-3">{compare}</span>}
        </p>
      )}
      {spark && spark.length > 1 && (
        <div className={cn('mt-3')}>
          <Sparkline values={spark} height={36} />
        </div>
      )}
    </Card>
  );
}
