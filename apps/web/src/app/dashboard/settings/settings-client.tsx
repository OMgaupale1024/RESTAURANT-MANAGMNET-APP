'use client';

import { useEffect, useState } from 'react';
import { getMe, type MeResponse } from '@/lib/api';
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
  const { accessToken } = useAuth();
  const [me, setMe] = useState<MeResponse | null>(null);

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
