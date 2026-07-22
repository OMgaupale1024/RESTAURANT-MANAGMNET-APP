'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiRequestError, register } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

/**
 * Creates the owner's account, then sends them straight to /setup — a fresh
 * registrant has zero memberships by construction, so there is no need to
 * call getMe first the way login does.
 */
export function RegisterForm() {
  const router = useRouter();
  const { setAccessToken } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);

    try {
      const { accessToken } = await register(email, password, name);
      setAccessToken(accessToken);
      setPassword('');
      router.push('/setup');
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(
          err.status === 429
            ? 'Too many attempts. Wait a minute and try again.'
            : err.message,
        );
      } else {
        setError('Could not reach the server. Check your connection.');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col">
      {error && (
        <p
          role="alert"
          className="animate-fade-up mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
          style={{ animationDelay: '0ms' }}
        >
          {error}
        </p>
      )}

      <div className="animate-fade-up" style={{ animationDelay: '40ms' }}>
        <label htmlFor="name" className="block text-sm font-medium">
          Your name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          required
          minLength={1}
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 mb-4 w-full rounded-md border border-line-2 bg-transparent px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        />
      </div>

      <div className="animate-fade-up" style={{ animationDelay: '80ms' }}>
        <label htmlFor="email" className="block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 mb-4 w-full rounded-md border border-line-2 bg-transparent px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        />
      </div>

      <div className="animate-fade-up" style={{ animationDelay: '120ms' }}>
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={72}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 mb-1 w-full rounded-md border border-line-2 bg-transparent px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        />
        <p className="mb-6 text-xs text-ink-3">At least 12 characters.</p>
      </div>

      <div className="animate-fade-up" style={{ animationDelay: '160ms' }}>
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-brand px-5 py-3 text-sm font-semibold text-brand-ink transition-colors duration-120 hover:brightness-95 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          {pending ? 'Creating account…' : 'Create account'}
        </button>
      </div>

      <p
        className="animate-fade-up mt-4 text-center text-sm text-ink-3"
        style={{ animationDelay: '200ms' }}
      >
        Already have an account?{' '}
        <Link href="/login" className="underline hover:text-ink-1">
          Sign in
        </Link>
      </p>
    </form>
  );
}
