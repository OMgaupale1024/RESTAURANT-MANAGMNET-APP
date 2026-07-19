import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/*
 * Composable table pieces (DESIGN.md §4). Numeric columns pass `numeric` for
 * right-aligned tabular figures. Sticky header only bites inside a
 * scroll-constrained parent; harmless otherwise.
 */

export function Table({
  className,
  containerClassName,
  children,
  ...rest
}: HTMLAttributes<HTMLTableElement> & { containerClassName?: string }) {
  return (
    // The wrapper is the scroll container sticky headers latch onto — pass a
    // max-height via containerClassName to get a sticky header on scroll.
    <div className={cn('overflow-x-auto', containerClassName)}>
      <table className={cn('w-full text-[13px]', className)} {...rest}>
        {children}
      </table>
    </div>
  );
}

export function Th({
  numeric,
  className,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      className={cn(
        'text-label sticky top-0 border-b border-line bg-surface px-3 py-2 text-left',
        numeric && 'text-right',
        className,
      )}
      {...rest}
    />
  );
}

export function Tr({
  className,
  onClick,
  ...rest
}: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      onClick={onClick}
      className={cn(
        'transition-colors duration-120',
        onClick && 'cursor-pointer hover:bg-surface-2',
        className,
      )}
      {...rest}
    />
  );
}

export function Td({
  numeric,
  className,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn(
        'border-b border-line/60 px-3 py-2.5',
        numeric && 'text-right tabular-nums',
        className,
      )}
      {...rest}
    />
  );
}
