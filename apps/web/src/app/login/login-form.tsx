'use client';

import { useState } from 'react';
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
    <form onSubmit={onSubmit} noValidate>
      {error && (
        // aria-live so screen readers announce a failure that appears without
        // a page change.
        <p
          role="alert"
          className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      )}

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
        className="mt-1 mb-4 w-full rounded-md border border-black/20 bg-transparent px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current dark:border-white/25"
      />

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
        className="mt-1 mb-6 w-full rounded-md border border-black/20 bg-transparent px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current dark:border-white/25"
      />

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-brand px-5 py-3 text-sm font-semibold text-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current hover:brightness-95 disabled:opacity-60"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
