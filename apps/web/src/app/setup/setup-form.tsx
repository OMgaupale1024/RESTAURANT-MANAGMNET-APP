'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ApiRequestError,
  createRestaurant,
  selectRestaurant,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

/**
 * Creates the user's restaurant, then immediately swaps the token for one
 * scoped to it — the tenant only becomes usable once it is in the JWT.
 *
 * Only name is required. The blueprint's full wizard (logo, cuisine, GST,
 * hours, tables, theme) is not here: logo needs object storage, and the rest
 * are settings that can be edited later. Asking for fifteen fields before an
 * owner has seen the product is how onboarding gets abandoned.
 */
export function SetupForm() {
  const router = useRouter();
  const { accessToken, status, setAccessToken } = useAuth();

  const [name, setName] = useState('');
  const [branchName, setBranchName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wait for the silent refresh to settle. Redirecting on a null token alone
  // would bounce the user to /login during every reload, while the refresh is
  // still in flight.
  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);

  if (status !== 'authenticated' || !accessToken) return null;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);

    try {
      const result = await createRestaurant(accessToken!, {
        name,
        ...(branchName ? { branchName } : {}),
      });

      // Swap for a restaurant-scoped token. Without this the user holds a
      // token with no tenant and every tenant-scoped call would fail.
      const { accessToken: scoped } = await selectRestaurant(
        accessToken!,
        result.restaurant.id,
      );
      setAccessToken(scoped);
      // The token is now restaurant-scoped, so the dashboard has a tenant.
      router.push('/dashboard');
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
    <form onSubmit={onSubmit} noValidate>
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <label htmlFor="name" className="block text-sm font-medium">
        Restaurant name
      </label>
      <input
        id="name"
        name="name"
        required
        minLength={2}
        maxLength={120}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="mt-1 mb-4 w-full rounded-md border border-black/20 bg-transparent px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current dark:border-white/25"
      />

      <label htmlFor="branchName" className="block text-sm font-medium">
        First branch <span className="text-black/50 dark:text-white/50">(optional)</span>
      </label>
      <input
        id="branchName"
        name="branchName"
        maxLength={120}
        placeholder="Main"
        value={branchName}
        onChange={(e) => setBranchName(e.target.value)}
        className="mt-1 mb-6 w-full rounded-md border border-black/20 bg-transparent px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current dark:border-white/25"
      />

      <button
        type="submit"
        disabled={pending || name.trim().length < 2}
        className="w-full rounded-md bg-brand px-5 py-3 text-sm font-semibold text-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current hover:brightness-95 disabled:opacity-60"
      >
        {pending ? 'Creating…' : 'Create restaurant'}
      </button>
    </form>
  );
}
