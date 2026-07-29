'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ApiRequestError, resetPassword } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormError } from '@/components/ui/form-error';

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
          <Link href="/forgot-password" className="underline hover:text-ink">
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
            className="inline-block w-full rounded-lg bg-brand px-5 py-3 text-center text-sm font-semibold text-brand-ink transition-colors duration-120 hover:brightness-95"
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
        {error && <FormError>{error}</FormError>}

        <label htmlFor="password" className="block text-sm font-medium">
          New password
        </label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 mb-1"
        />
        <p className="mb-4 text-xs text-ink-3">At least 12 characters.</p>

        <label htmlFor="confirm" className="block text-sm font-medium">
          Confirm new password
        </label>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="mt-1 mb-6"
        />

        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={pending || !valid}
          className="w-full"
        >
          {pending ? 'Updating…' : 'Update password'}
        </Button>
      </form>
    </>
  );
}
