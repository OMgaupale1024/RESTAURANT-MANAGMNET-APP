'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

/**
 * Route-level error boundary. Catches unexpected runtime/render errors thrown
 * anywhere below the root layout and shows a branded recovery screen instead
 * of the framework's unstyled fallback. global-error.tsx handles the one thing
 * this cannot reach — an error in the root layout itself.
 *
 * Security: the caught error is logged to the browser console for debugging
 * but NEVER rendered. No message, no stack — a Client Component error would
 * otherwise carry its original message. The user sees a generic message and,
 * if present, the opaque `digest` (a hash, safe to show) to quote to support.
 */
export default function Error({
  error,
  // Next 16.2 recovery prop: re-fetches AND re-renders the segment, which is
  // what "try again" should mean. `reset` (re-render only) is the fallback.
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-page p-6">
      <div className="w-full max-w-md animate-fade-up text-center">
        <div className="mx-auto grid size-11 place-items-center rounded-xl bg-brand text-[15px] font-bold text-brand-ink">
          O
        </div>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-ink-2">
          An unexpected error occurred. You can try again, or head back to your
          dashboard.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Button variant="primary" size="lg" onClick={() => unstable_retry()}>
            Try again
          </Button>
          <Button
            variant="secondary"
            size="lg"
            onClick={() => router.push('/dashboard')}
          >
            Return to dashboard
          </Button>
        </div>
        {error.digest && (
          <p className="mt-6 font-mono text-[11px] text-ink-3">
            Reference: {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
