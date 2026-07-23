'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiRequestError, register } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormError } from '@/components/ui/form-error';

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
      {error && <FormError>{error}</FormError>}

      <div className="animate-fade-up" style={{ animationDelay: '40ms' }}>
        <label htmlFor="name" className="block text-sm font-medium">
          Your name
        </label>
        <Input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          required
          minLength={1}
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 mb-4"
        />
      </div>

      <div className="animate-fade-up" style={{ animationDelay: '80ms' }}>
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

      <div className="animate-fade-up" style={{ animationDelay: '120ms' }}>
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={72}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 mb-1"
        />
        <p className="mb-6 text-xs text-ink-3">At least 12 characters.</p>
      </div>

      <div className="animate-fade-up" style={{ animationDelay: '160ms' }}>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={pending}
          className="w-full"
        >
          {pending ? 'Creating account…' : 'Create account'}
        </Button>
      </div>

      <p
        className="animate-fade-up mt-4 text-center text-sm text-ink-3"
        style={{ animationDelay: '200ms' }}
      >
        Already have an account?{' '}
        <Link href="/login" className="underline hover:text-ink">
          Sign in
        </Link>
      </p>
    </form>
  );
}
