'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ApiRequestError,
  createRestaurant,
  selectRestaurant,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormError } from '@/components/ui/form-error';

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
    <form onSubmit={onSubmit} noValidate className="flex flex-col">
      {error && <FormError>{error}</FormError>}

      <div className="animate-fade-up" style={{ animationDelay: '40ms' }}>
        <label htmlFor="name" className="block text-sm font-medium">
          Restaurant name
        </label>
        <Input
          id="name"
          name="name"
          required
          minLength={2}
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 mb-4"
        />
      </div>

      <div className="animate-fade-up" style={{ animationDelay: '80ms' }}>
        <label htmlFor="branchName" className="block text-sm font-medium">
          First branch <span className="text-ink-3">(optional)</span>
        </label>
        <Input
          id="branchName"
          name="branchName"
          maxLength={120}
          placeholder="Main"
          value={branchName}
          onChange={(e) => setBranchName(e.target.value)}
          className="mt-1 mb-6"
        />
      </div>

      <div className="animate-fade-up" style={{ animationDelay: '120ms' }}>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={pending || name.trim().length < 2}
          className="w-full"
        >
          {pending ? 'Creating…' : 'Create restaurant'}
        </Button>
      </div>
    </form>
  );
}
