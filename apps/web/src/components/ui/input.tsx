import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/cn';

/* Shared field chrome. Native elements only — no custom pickers. */
const FIELD =
  'w-full rounded-lg border bg-surface px-3 text-sm text-ink placeholder:text-ink-3 ' +
  'transition-[border-color,box-shadow] duration-120 ' +
  'focus:outline-none focus:border-ink focus:ring-2 focus:ring-ink/10 ' +
  'disabled:opacity-50';

function borderFor(error?: boolean) {
  return error ? 'border-danger' : 'border-line-2';
}

export function Input({
  error,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { error?: boolean }) {
  return (
    <input className={cn(FIELD, 'h-9', borderFor(error), className)} {...rest} />
  );
}

export function Select({
  error,
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { error?: boolean }) {
  return (
    <select className={cn(FIELD, 'h-9', borderFor(error), className)} {...rest} />
  );
}

export function Textarea({
  error,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { error?: boolean }) {
  return (
    <textarea
      className={cn(FIELD, 'min-h-20 py-2', borderFor(error), className)}
      {...rest}
    />
  );
}

/** Label + control + inline error, stacked. */
export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-label mb-1.5 block">{label}</span>
      {children}
      {error && (
        <p role="alert" className="mt-1.5 text-[12px] text-danger-text">
          {error}
        </p>
      )}
    </label>
  );
}
