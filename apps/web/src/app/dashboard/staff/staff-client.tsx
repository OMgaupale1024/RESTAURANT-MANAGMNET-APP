'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiRequestError,
  clockMember,
  createInvite,
  listInvites,
  listStaff,
  revokeInvite,
  updateMember,
  type PendingInvite,
  type StaffMember,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

const ROLES = ['MANAGER', 'CASHIER', 'KITCHEN'] as const;

export function StaffClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback(
    (t: string) => setAccessToken(t),
    [setAccessToken],
  );

  const [members, setMembers] = useState<StaffMember[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const [team, pending] = await Promise.all([
          listStaff(accessToken, onNewToken),
          // A cashier can read the team but not the invites; a 403 here is
          // expected, not an error worth showing.
          listInvites(accessToken, onNewToken).catch(() => [] as PendingInvite[]),
        ]);
        if (!cancelled) {
          setMembers(team);
          setInvites(pending);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiRequestError ? e.message : 'Could not load staff');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, reloadKey]);

  async function act(fn: () => Promise<unknown>) {
    if (!accessToken) return;
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Action failed');
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Staff</h1>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      )}

      {inviteUrl && (
        <div
          role="status"
          className="mt-4 rounded-md border border-green-600/40 bg-green-600/10 px-3 py-3 text-sm"
        >
          <p className="font-medium text-green-800 dark:text-green-300">
            Invite created — share this link. It is shown only once.
          </p>
          <code className="mt-2 block break-all rounded bg-black/5 px-2 py-1 text-xs dark:bg-white/10">
            {inviteUrl}
          </code>
          <button
            type="button"
            onClick={() => setInviteUrl(null)}
            className="mt-2 text-xs underline"
          >
            Done
          </button>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_20rem]">
        <section aria-labelledby="team-heading">
          <h2 id="team-heading" className="text-sm font-medium">
            Team
          </h2>
          <ul className="mt-3 divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/15 dark:border-white/15">
            {members.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm"
              >
                <span className="font-medium">{m.user.name}</span>
                <span className="rounded bg-black/10 px-2 py-0.5 text-xs dark:bg-white/15">
                  {m.role.name}
                </span>
                {/* State is stated in words, never colour alone. */}
                {m.onShift && (
                  <span className="rounded bg-green-600/15 px-2 py-0.5 text-xs font-medium text-green-800 dark:text-green-300">
                    On shift
                  </span>
                )}
                {!m.isActive && (
                  <span className="rounded bg-black/10 px-2 py-0.5 text-xs dark:bg-white/15">
                    Inactive
                  </span>
                )}

                <span className="ml-auto flex flex-wrap gap-1">
                  {/* The owner is deliberately not editable here — locking
                      yourself out should not be one click. */}
                  {m.role.key !== 'OWNER' && m.isActive && (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          act(() =>
                            clockMember(
                              accessToken!,
                              onNewToken,
                              m.id,
                              m.onShift ? 'CLOCK_OUT' : 'CLOCK_IN',
                            ),
                          )
                        }
                        className="rounded border border-black/20 px-2 py-1 text-xs dark:border-white/25"
                      >
                        {m.onShift ? 'Clock out' : 'Clock in'}
                      </button>
                      <select
                        aria-label={`Role for ${m.user.name}`}
                        value={m.role.key}
                        onChange={(e) =>
                          act(() =>
                            updateMember(accessToken!, onNewToken, m.id, {
                              role: e.target.value,
                            }),
                          )
                        }
                        className="rounded border border-black/20 bg-transparent px-1 py-1 text-xs dark:border-white/25"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r.charAt(0) + r.slice(1).toLowerCase()}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() =>
                          act(() =>
                            updateMember(accessToken!, onNewToken, m.id, {
                              isActive: false,
                            }),
                          )
                        }
                        className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-700 dark:text-red-300"
                      >
                        Remove
                      </button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>

          {invites.length > 0 && (
            <>
              <h2 className="mt-6 text-sm font-medium">Pending invites</h2>
              <ul className="mt-2 divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/15 dark:border-white/15">
                {invites.map((i) => (
                  <li
                    key={i.id}
                    className="flex items-center gap-2 px-4 py-2 text-sm"
                  >
                    <span className="truncate">{i.email}</span>
                    <span className="text-xs text-black/50 dark:text-white/50">
                      {i.role.name}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        act(() => revokeInvite(accessToken!, onNewToken, i.id))
                      }
                      className="ml-auto text-xs underline"
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section
          aria-labelledby="invite-heading"
          className="rounded-lg border border-black/10 p-4 dark:border-white/15"
        >
          <h2 id="invite-heading" className="text-sm font-medium">
            Invite someone
          </h2>
          <p className="mt-1 text-xs text-black/60 dark:text-white/60">
            They set their own password. You never see it.
          </p>
          <InviteForm
            accessToken={accessToken}
            onNewToken={onNewToken}
            onCreated={(url) => {
              setInviteUrl(url);
              reload();
            }}
            setError={setError}
          />
        </section>
      </div>
    </div>
  );
}

function InviteForm({
  accessToken,
  onNewToken,
  onCreated,
  setError,
}: {
  accessToken: string | null;
  onNewToken: (t: string) => void;
  onCreated: (url: string) => void;
  setError: (m: string | null) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('CASHIER');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createInvite(accessToken, onNewToken, {
        email: email.trim(),
        role,
      });
      setEmail('');
      onCreated(res.inviteUrl);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not invite');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3">
      <label htmlFor="inv-email" className="block text-xs font-medium">
        Email
      </label>
      <input
        id="inv-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="mt-1 mb-3 w-full rounded-md border border-black/20 bg-transparent px-3 py-2 text-sm dark:border-white/25"
      />

      <label htmlFor="inv-role" className="block text-xs font-medium">
        Role
      </label>
      <select
        id="inv-role"
        value={role}
        onChange={(e) => setRole(e.target.value)}
        className="mt-1 mb-4 w-full rounded-md border border-black/20 bg-transparent px-2 py-2 text-sm dark:border-white/25"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r.charAt(0) + r.slice(1).toLowerCase()}
          </option>
        ))}
      </select>

      <button
        type="submit"
        disabled={busy || !email.trim()}
        className="w-full rounded-md bg-brand px-3 py-2 text-sm font-semibold text-brand-ink hover:brightness-95 disabled:opacity-50"
      >
        {busy ? 'Creating…' : 'Create invite link'}
      </button>
    </form>
  );
}
