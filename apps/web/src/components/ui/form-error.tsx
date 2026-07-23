import type { ReactNode } from 'react';

/**
 * Form-level error callout — the danger-token twin of the inline field error in
 * Field(). One box, token-driven (`--color-danger*`, never raw red), announced
 * to screen readers. Replaces the hand-rolled red boxes each auth form carried.
 * `text-danger-text` already flips light↔dark, so no `dark:` variant is needed.
 */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="animate-fade-up mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-text"
    >
      {children}
    </p>
  );
}
