'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  getMe,
  logout as apiLogout,
  logoutAll,
  type MeResponse,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Read-only by design (DESIGN.md §6): there are no settings-write endpoints
 * yet (no restaurant PATCH, no profile PATCH). Sections become editable when
 * the API ships them — no fake toggles before that.
 */
export function SettingsClient() {
  const router = useRouter();
  const { accessToken, clear } = useAuth();
  const [me, setMe] = useState<MeResponse | null>(null);

  async function onSignOut() {
    // The button says "everywhere", so it must actually revoke every session.
    // Falls back to the single-session logout if that call fails, so the user
    // is never left signed in on this device after asking to leave.
    if (accessToken) {
      await logoutAll(accessToken).catch(() => apiLogout().catch(() => undefined));
    } else {
      await apiLogout().catch(() => undefined);
    }
    clear();
    router.replace('/login');
  }

  useEffect(() => {
    if (!accessToken) return;
    getMe(accessToken).then(setMe).catch(() => undefined);
  }, [accessToken]);

  if (!me) {
    return (
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <div className="mt-6 max-w-xl space-y-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    );
  }

  const current = me.memberships[0];

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>

      <div className="mt-6 max-w-xl space-y-4">
        <Card>
          <CardHeader title="Profile" />
          <dl className="space-y-3 text-sm">
            <Row label="Name" value={me.user.name} />
            <Row label="Email" value={me.user.email} />
          </dl>
        </Card>

        <Card>
          <CardHeader
            title="Restaurant"
            action={current && <Badge>{current.role.name}</Badge>}
          />
          <dl className="space-y-3 text-sm">
            <Row label="Name" value={current?.restaurant.name ?? '—'} />
            <Row label="Workspaces" value={String(me.memberships.length)} />
          </dl>
          <p className="mt-4 text-[12px] text-ink-3">
            Restaurant details are read-only for now. Editing arrives with the
            settings API.
          </p>
        </Card>

        <Card>
          <CardHeader title="Session" />
          <dl className="space-y-3 text-sm mb-4">
            <Row label="Current Workspace" value={current?.restaurant.name ?? '—'} />
            <Row label="Role" value={current?.role.name ?? '—'} />
          </dl>
          <button
            type="button"
            onClick={onSignOut}
            className="rounded-md border border-line-2 bg-surface px-4 py-2 text-sm font-semibold text-danger transition-colors duration-120 hover:border-danger hover:bg-danger/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
          >
            Sign out everywhere
          </button>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-2">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  );
}
