'use client';

import { cn } from '@/lib/cn';

/**
 * Segmented control with a sliding thumb (DESIGN.md §4). Segments are
 * equal-width so the thumb is one absolutely-positioned element moved with
 * translateX — the cheap, reliable shared-element transition.
 */
export function Segmented<K extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: ReadonlyArray<{ key: K; label: string }>;
  value: K;
  onChange: (key: K) => void;
  className?: string;
}) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.key === value),
  );

  return (
    <div
      className={cn(
        'relative grid auto-cols-fr grid-flow-col rounded-lg bg-surface-2 p-1',
        className,
      )}
    >
      <span
        aria-hidden
        className="absolute inset-y-1 left-1 rounded-md border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-transform duration-180 ease-(--ease-swift)"
        style={{
          width: `calc((100% - 8px) / ${options.length})`,
          transform: `translateX(${index * 100}%)`,
        }}
      />
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={o.key === value}
          onClick={() => onChange(o.key)}
          className={cn(
            'relative z-10 rounded-md px-3 py-1.5 text-[13px] whitespace-nowrap transition-colors duration-120',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current',
            o.key === value ? 'font-medium text-ink' : 'text-ink-2 hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
