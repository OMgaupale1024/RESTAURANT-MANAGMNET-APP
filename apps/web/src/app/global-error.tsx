'use client';

import { useEffect } from 'react';
// Replaces the root layout when active, so it must bring its own styles.
import './globals.css';

/**
 * Last-resort boundary: catches errors in the ROOT layout itself, which the
 * route-level app/error.tsx cannot reach. It replaces the whole document, so
 * it renders its own <html>/<body> and depends on nothing above it — the
 * providers and fonts may be exactly what failed. Styling is globals.css only,
 * and recovery uses a hard navigation rather than the client router, which may
 * be in a broken state.
 *
 * Same security rule as app/error.tsx: the error is logged, never displayed.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="antialiased">
        {/* metadata exports are unsupported here; set the tab title directly. */}
        <title>Something went wrong — OraOS</title>
        <div className="flex min-h-dvh flex-col items-center justify-center bg-page p-6">
          <div className="w-full max-w-md text-center">
            <div className="mx-auto grid size-11 place-items-center rounded-xl bg-brand text-[15px] font-bold text-brand-ink">
              O
            </div>
            <h1 className="mt-6 text-2xl font-semibold tracking-tight text-ink">
              Something went wrong
            </h1>
            <p className="mt-2 text-sm text-ink-2">
              An unexpected error occurred. You can try again, or head back to
              your dashboard.
            </p>
            <div className="mt-8 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => unstable_retry()}
                className="inline-flex h-11 select-none items-center justify-center rounded-lg bg-brand px-5 text-[15px] font-medium text-brand-ink transition-[filter] duration-120 hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
              >
                Try again
              </button>
              <a
                href="/dashboard"
                className="inline-flex h-11 select-none items-center justify-center rounded-lg border border-line-2 bg-surface px-5 text-[15px] font-medium text-ink transition-colors duration-120 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
              >
                Return to dashboard
              </a>
            </div>
            {error.digest && (
              <p className="mt-6 font-mono text-[11px] text-ink-3">
                Reference: {error.digest}
              </p>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}
