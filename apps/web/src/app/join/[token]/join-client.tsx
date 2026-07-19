'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { acceptInvite, ApiRequestError, describeInvite } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Card } from '@/components/ui/card';

/**
 * Invite acceptance.
 *
 * The invitee sets their own password here — the owner never sees it, which is
 * what keeps every audit entry and every void attributable to a real person.
 *
 * The email is NOT editable: it comes from the invite. A forwarded link must
 * not let someone join under a different address.
 */
export function JoinClient({ token }: { token: string }) {
  const router = useRouter();
  const { setAccessToken } = useAuth();

  const [invite, setInvite] = useState<{
    email: string;
    restaurantName: string;
    role: { name: string };
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await describeInvite(token);
        if (!cancelled) setInvite(data);
      } catch {
        // Expired, revoked, used, never-existed — all the same to the user,
        // and deliberately the same to anyone probing a token.
        if (!cancelled) setError('This invitation is no longer valid.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { accessToken } = await acceptInvite(token, {
        name: name.trim(),
        password,
      });
      // Signed straight in, already scoped to the restaurant they joined.
      setAccessToken(accessToken);
      setPassword('');
      router.push('/dashboard');
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : 'Could not join',
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <Card className="p-6 text-center">
        <p className="text-sm text-ink-2">Loading…</p>
      </Card>
    );
  }

  if (!invite) {
    return (
      <Card className="p-6">
        <div role="alert">
          <h1 className="text-2xl font-semibold tracking-tight">
            Invitation not valid
          </h1>
          <p className="mt-2 text-sm text-ink-2">
            {error ?? 'This link has expired or has already been used.'}
          </p>
          <p className="mt-4 text-sm text-ink-3">
            Ask whoever invited you to send a new link.
          </p>
        </div>
      </Card>
    );
  }

  const valid = name.trim().length > 0 && password.length >= 12;

  return (
    <Card className="p-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        Join {invite.restaurantName}
      </h1>
      <p className="mt-2 mb-6 text-sm text-ink-2">
        You are joining as {invite.role.name}.
      </p>

      <form onSubmit={submit} noValidate className="flex flex-col">
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
          <label htmlFor="j-email" className="block text-sm font-medium">
            Email
          </label>
          <input
            id="j-email"
            value={invite.email}
            readOnly
            className="mt-1 mb-4 w-full rounded-md border border-line-2 bg-surface-2 px-3 py-2 text-sm text-ink-2 cursor-not-allowed"
          />
        </div>

        <div className="animate-fade-up" style={{ animationDelay: '80ms' }}>
          <label htmlFor="j-name" className="block text-sm font-medium">
            Your name
          </label>
          <input
            id="j-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            className="mt-1 mb-4 w-full rounded-md border border-line-2 bg-transparent px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
          />
        </div>

        <div className="animate-fade-up" style={{ animationDelay: '120ms' }}>
          <label htmlFor="j-password" className="block text-sm font-medium">
            Choose a password
          </label>
          <input
            id="j-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            className="mt-1 w-full rounded-md border border-line-2 bg-transparent px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
          />
          <p className="mt-1 mb-6 text-xs text-ink-3">
            At least 12 characters. Nobody else will know it.
          </p>
        </div>

        <div className="animate-fade-up" style={{ animationDelay: '160ms' }}>
          <button
            type="submit"
            disabled={!valid || busy}
            className="w-full rounded-md bg-brand px-5 py-3 text-sm font-semibold text-brand-ink transition-colors duration-120 hover:brightness-95 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
          >
            {busy ? 'Joining…' : 'Join'}
          </button>
        </div>
      </form>
    </Card>
  );
}
