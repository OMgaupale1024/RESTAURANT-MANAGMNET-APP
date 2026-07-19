import { cn } from '@/lib/cn';

/** Shimmer block. Size it with className to match the content it stands in for. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton', className)} />;
}
