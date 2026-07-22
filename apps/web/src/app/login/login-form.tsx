'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiRequestError, getMe, login } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

/**
 * The access token is held in component state — in memory, never in
 * localStorage or a readable cookie.
 *
 * Anything JavaScript can read, an XSS payload can exfiltrate. Memory dies
 * with the tab; the refresh token lives in an httpOnly cookie the browser
 * sends automatically and JS cannot touch. That pair is the whole design.
 *
 * The token is handed to AuthProvider, which also restores it after a reload
 * by calling /auth/refresh with the httpOnly cookie.
 */
export function LoginForm() {
  const router = useRouter();
  const { setAccessToken } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);

    try {
      const { accessToken } = await login(email, password);
      setAccessToken(accessToken);
      setPassword('');

      // Owners with a restaurant go to the dashboard; everyone else must set
      // one up first. There is nothing else they can usefully do.
      const me = await getMe(accessToken);
      router.push(me.memberships.length > 0 ? '/dashboard' : '/setup');
    } catch (err) {
      // Show the server's message verbatim. It is deliberately vague
      // ("Invalid email or password") so the UI must not try to be helpful by
      // guessing which field was wrong — that is account enumeration.
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

      <div className="animate-fade-up" style={{ animationDelay: '80ms' }}>
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 mb-6 w-full rounded-md border border-line-2 bg-transparent px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        />
      </div>

      <div className="animate-fade-up" style={{ animationDelay: '120ms' }}>
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-brand px-5 py-3 text-sm font-semibold text-brand-ink transition-colors duration-120 hover:brightness-95 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </div>

      <p
        className="animate-fade-up mt-4 text-center text-sm text-ink-3"
        style={{ animationDelay: '160ms' }}
      >
        <Link href="/forgot-password" className="underline hover:text-ink-1">
          Forgot your password?
        </Link>
      </p>
      <p
        className="animate-fade-up mt-2 text-center text-sm text-ink-3"
        style={{ animationDelay: '180ms' }}
      >
        New restaurant?{' '}
        <Link href="/register" className="underline hover:text-ink-1">
          Create an account
        </Link>
      </p>
    </form>
  );
}
