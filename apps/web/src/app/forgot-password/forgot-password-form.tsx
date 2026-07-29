'use client';

import { useState } from 'react';
import { forgotPassword } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * The success message is deliberately vague and shown regardless of whether the
 * email exists — the API never reveals which addresses are registered, and the
 * UI must not either.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    try {
      await forgotPassword(email);
    } catch {
      // Even a transport error resolves to the same neutral message: a failure
      // here must not become an enumeration signal.
    } finally {
      setPending(false);
      setSent(true);
    }
  }

  if (sent) {
    return (
      <p
        role="status"
        className="animate-fade-up rounded-md border border-line-2 bg-surface-2 px-4 py-3 text-sm text-ink-2"
      >
        If an account exists for <span className="font-medium">{email}</span>,
        a password reset link is on its way. Check your inbox — the link expires
        in 30 minutes.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col">
      <label htmlFor="email" className="block text-sm font-medium">
        Email
      </label>
      <Input
        id="email"
        name="email"
        type="email"
        autoComplete="username"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="mt-1 mb-6"
      />
      <Button
        type="submit"
        variant="primary"
        size="lg"
        disabled={pending || email.trim().length === 0}
        className="w-full"
      >
        {pending ? 'Sending…' : 'Send reset link'}
      </Button>
    </form>
  );
}
