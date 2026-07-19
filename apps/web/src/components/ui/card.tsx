import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({
  hover = false,
  dense = false,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { hover?: boolean; dense?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]',
        dense ? 'p-3' : 'p-5',
        hover &&
          'transition-[border-color,transform] duration-120 hover:-translate-y-px hover:border-line-2',
        className,
      )}
      {...rest}
    />
  );
}

/** Heading row inside a Card: title left, optional action right. */
export function CardHeader({
  title,
  action,
}: {
  title: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-2">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {action}
    </div>
  );
}
