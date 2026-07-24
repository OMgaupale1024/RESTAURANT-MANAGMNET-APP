'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from './button';
import { Field, Textarea } from './input';

/**
 * Native <dialog> modal — focus trap, Esc, inert background for free.
 * Backdrop click closes (a click on the dialog element itself is the
 * backdrop; content clicks land on children).
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
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
        'm-auto w-full max-w-[480px] rounded-2xl border border-line bg-surface p-6 text-ink',
        'shadow-[0_16px_48px_rgb(0_0_0/0.16)] backdrop:bg-black/40 backdrop:backdrop-blur-[4px]',
        'dialog-anim dialog-pop',
        className,
      )}
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        {title && <h2 id={titleId} className="text-[15px] font-semibold">{title}</h2>}
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

/**
 * Destructive-action confirmation (DESIGN.md §4): names the consequence,
 * optionally requires a typed reason (e.g. void), which is passed through.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  requireReason = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason?: string) => void;
  title: string;
  body: string;
  confirmLabel: string;
  requireReason?: boolean;
}) {
  const [reason, setReason] = useState('');

  // Reset on the way out (close or confirm) so a reopen starts blank —
  // resetting in an `open` effect trips react-hooks/set-state-in-effect.
  const close = () => {
    setReason('');
    onClose();
  };

  return (
    <Modal open={open} onClose={close} title={title}>
      <p className="text-sm text-ink-2">{body}</p>
      {requireReason && (
        <div className="mt-4">
          <Field label="Reason">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this being done?"
            />
          </Field>
        </div>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={requireReason && reason.trim() === ''}
          onClick={() => onConfirm(requireReason ? reason.trim() : undefined)}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
