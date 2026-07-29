'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Right-side detail panel on a native <dialog> — keeps the list in view
 * behind it. Full-screen on phones (DESIGN.md §8).
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  className,
  side = 'right',
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  side?: 'right' | 'left';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={title ? titleId : undefined}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        // A closed dialog must stay display:none even when a caller's
        // className sets a display (e.g. `flex`) — otherwise an invisible
        // pointer-events layer covers the page. The :not([open]) variant
        // out-specifies any plain utility; allow-discrete still animates it.
        '[&:not([open])]:hidden',
        'fixed m-0 h-dvh max-h-none w-full max-w-full overflow-y-auto bg-surface p-6 text-ink sm:max-w-[420px]',
        'shadow-[0_16px_48px_rgb(0_0_0/0.16)] backdrop:bg-black/40 backdrop:backdrop-blur-[6px]',
        'dialog-anim',
        side === 'right'
          ? 'ml-auto border-l border-line dialog-slide-right'
          : 'mr-auto border-r border-line dialog-slide-left',
        className,
      )}
    >
      <div className="mb-5 flex items-start justify-between gap-4">
        {title && <div id={titleId} className="min-w-0 text-[15px] font-semibold">{title}</div>}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="-m-1 ml-auto rounded-md p-1 text-ink-3 transition-colors duration-120 hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          <X className="size-4" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
