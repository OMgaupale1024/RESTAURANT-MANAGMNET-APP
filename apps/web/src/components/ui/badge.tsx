import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

/* Status badges pair color with a label (and usually an icon from the
   caller) — color never carries meaning alone. */
const VARIANTS: Record<Variant, string> = {
  neutral: 'bg-surface-2 text-ink-2',
  success: 'bg-success/10 text-success-text',
  warning: 'bg-warning/10 text-warning-text',
  danger: 'bg-danger/10 text-danger-text',
  info: 'bg-info/10 text-info-text',
  brand: 'bg-brand text-brand-ink',
};

export function Badge({
  variant = 'neutral',
  className,
  children,
}: {
  variant?: Variant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        VARIANTS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
