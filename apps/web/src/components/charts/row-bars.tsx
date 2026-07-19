'use client';

export type Row = { label: string; value: number; display: string; hint?: string };

/**
 * Horizontal bars: top products, payment breakdown, segment sizes. Nominal
 * categories all wear slot 1 (identity channel is not spent re-encoding what
 * length shows). Every row is direct-labeled — this is the §2 relief rule,
 * so the sub-3:1 light-mode series colors are never the only channel.
 */
export function RowBars({ rows }: { rows: Row[] }) {
  const max = Math.max(...rows.map((r) => r.value), 1);

  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => (
        <li key={r.label} className="text-[13px]">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="shrink-0 font-medium tabular-nums">{r.display}</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
              <span
                className="block h-full origin-left rounded-full bg-(--series-1)"
                style={{
                  width: `${(r.value / max) * 100}%`,
                  animation: `bar-grow-x 400ms var(--ease-out-quart) ${Math.min(i * 40, 240)}ms both`,
                }}
              />
            </span>
            {r.hint && (
              <span className="shrink-0 text-[11px] text-ink-3 tabular-nums">{r.hint}</span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
