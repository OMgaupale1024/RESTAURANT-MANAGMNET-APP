'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ApiRequestError, resetPassword } from '@/lib/api';

/**
 * Sets a new password from a reset link. On success we do NOT sign the user in —
 * they return to /login and use the new password, so possession of the link
 * alone never yields a live session. An invalid or expired link is surfaced
 * plainly so the user knows to request a fresh one.
 */
export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setPending(true);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : 'Could not reset your password. Try again.',
      );
    } finally {
      setPending(false);
    }
  }

  if (!token) {
    return (
      <div role="alert">
        <h1 className="text-2xl font-semibold tracking-tight">
          Link not valid
        </h1>
        <p className="mt-2 text-sm text-ink-2">
          This reset link is missing or malformed. Request a new one.
        </p>
        <p className="mt-4 text-sm">
          <Link href="/forgot-password" className="underline hover:text-ink-1">
            Request a new link
          </Link>
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div role="status">
        <h1 className="text-2xl font-semibold tracking-tight">
          Password updated
        </h1>
        <p className="mt-2 text-sm text-ink-2">
          You&apos;ve been signed out of all devices. Sign in with your new
          password.
        </p>
        <p className="mt-6">
          <Link
            href="/login"
            className="inline-block w-full rounded-md bg-brand px-5 py-3 text-center text-sm font-semibold text-brand-ink transition-colors duration-120 hover:brightness-95"
          >
            Go to sign in
          </Link>
        </p>
      </div>
    );
  }

  const valid = password.length >= 12 && confirm.length > 0;

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">
        Choose a new password
      </h1>
      <form onSubmit={onSubmit} noValidate className="flex flex-col">
        {error && (
          <p
            role="alert"
            className="animate-fade-up mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
          >
            {error}
          </p>
        )}

        <label htmlFor="password" className="block text-sm font-medium">
          New password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 mb-1 w-full rounded-md border border-line-2 bg-transparent px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        />
        <p className="mb-4 text-xs text-ink-3">At least 12 characters.</p>

        <label htmlFor="confirm" className="block text-sm font-medium">
          Confirm new password
        </label>
        <input
          id="confirm"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="mt-1 mb-6 w-full rounded-md border border-line-2 bg-transparent px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        />

        <button
          type="submit"
          disabled={pending || !valid}
          className="w-full rounded-md bg-brand px-5 py-3 text-sm font-semibold text-brand-ink transition-colors duration-120 hover:brightness-95 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          {pending ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </>
  );
}
