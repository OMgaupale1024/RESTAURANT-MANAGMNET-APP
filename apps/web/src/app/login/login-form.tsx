'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiRequestError, getMe, login } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormError } from '@/components/ui/form-error';

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
      {error && <FormError>{error}</FormError>}

      <div className="animate-fade-up" style={{ animationDelay: '40ms' }}>
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
          className="mt-1 mb-4"
        />
      </div>

      <div className="animate-fade-up" style={{ animationDelay: '80ms' }}>
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 mb-6"
        />
      </div>

      <div className="animate-fade-up" style={{ animationDelay: '120ms' }}>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={pending}
          className="w-full"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </div>

      <p
        className="animate-fade-up mt-4 text-center text-sm text-ink-3"
        style={{ animationDelay: '160ms' }}
      >
        <Link href="/forgot-password" className="underline hover:text-ink">
          Forgot your password?
        </Link>
      </p>
      <p
        className="animate-fade-up mt-2 text-center text-sm text-ink-3"
        style={{ animationDelay: '180ms' }}
      >
        New restaurant?{' '}
        <Link href="/register" className="underline hover:text-ink">
          Create an account
        </Link>
      </p>
    </form>
  );
}
