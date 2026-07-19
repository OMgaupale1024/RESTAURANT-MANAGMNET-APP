import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * Honest empty state (DESIGN.md §1.5): name the action that produces data.
 * Never render fabricated numbers in place of one of these.
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {Icon && <Icon aria-hidden className="mb-3 size-6 text-ink-3" />}
      <p className="text-sm font-medium">{title}</p>
      {body && <p className="mt-1 max-w-sm text-[13px] text-ink-2">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
