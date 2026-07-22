'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ApiRequestError, verifyEmail } from '@/lib/api';

/**
 * Confirms an email address from the link. The token in the URL is the whole
 * credential — this page just posts it and reports the outcome. It runs the
 * verification once on mount (StrictMode-guarded), so the user only clicks the
 * email link; there is nothing to submit here.
 */
export function VerifyEmailClient({ token }: { token: string }) {
  const [state, setState] = useState<'working' | 'done' | 'error'>(
    token ? 'working' : 'error',
  );
  const [error, setError] = useState<string | null>(
    token ? null : 'This confirmation link is missing or malformed.',
  );
  const ran = useRef(false);

  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true;
    verifyEmail(token)
      .then(() => setState('done'))
      .catch((err: unknown) => {
        setError(
          err instanceof ApiRequestError
            ? err.message
            : 'Could not confirm your email. Try again.',
        );
        setState('error');
      });
  }, [token]);

  if (state === 'working') {
    return (
      <div role="status">
        <h1 className="text-2xl font-semibold tracking-tight">Confirming…</h1>
        <p className="mt-2 text-sm text-ink-2">One moment while we confirm your email.</p>
      </div>
    );
  }

  if (state === 'done') {
    return (
      <div role="status">
        <h1 className="text-2xl font-semibold tracking-tight">Email confirmed</h1>
        <p className="mt-2 text-sm text-ink-2">
          Thanks — your email address is verified.
        </p>
        <p className="mt-6">
          <Link
            href="/dashboard"
            className="inline-block w-full rounded-md bg-brand px-5 py-3 text-center text-sm font-semibold text-brand-ink transition-colors duration-120 hover:brightness-95"
          >
            Go to dashboard
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div role="alert">
      <h1 className="text-2xl font-semibold tracking-tight">Link not valid</h1>
      <p className="mt-2 text-sm text-ink-2">{error}</p>
      <p className="mt-4 text-sm text-ink-3">
        You can request a fresh link from Settings once you&apos;re signed in.
      </p>
      <p className="mt-6">
        <Link
          href="/dashboard"
          className="inline-block w-full rounded-md bg-brand px-5 py-3 text-center text-sm font-semibold text-brand-ink transition-colors duration-120 hover:brightness-95"
        >
          Go to dashboard
        </Link>
      </p>
    </div>
  );
}
