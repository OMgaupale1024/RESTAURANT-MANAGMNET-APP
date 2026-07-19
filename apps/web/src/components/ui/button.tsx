import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-brand-ink border border-transparent hover:brightness-95',
  secondary: 'bg-surface text-ink border border-line-2 hover:bg-surface-2',
  ghost: 'text-ink border border-transparent hover:bg-surface-2',
  danger: 'text-danger-text border border-danger/40 hover:bg-danger/10',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[13px] gap-1',
  md: 'h-9 px-3.5 text-sm gap-1.5',
  lg: 'h-11 px-5 text-[15px] gap-2',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
}) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex select-none items-center justify-center rounded-lg font-medium',
        'transition-[background-color,border-color,transform,filter] duration-120',
        'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
}
