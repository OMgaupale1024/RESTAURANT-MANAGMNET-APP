'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ApiRequestError,
  getMe,
  getRestaurantProfile,
  logout as apiLogout,
  logoutAll,
  resendVerification,
  updateRestaurantProfile,
  type MeResponse,
  type RestaurantProfile,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';

/**
 * Settings — the business profile behind the printed receipt.
 *
 * Editing is offered only to OWNER (restaurant.update in the seeded roles);
 * everyone else sees the same data read-only. The API is the boundary — the
 * client-side gate is a courtesy, not security.
 */
export function SettingsClient() {
  const router = useRouter();
  const { accessToken, setAccessToken, clear } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [me, setMe] = useState<MeResponse | null>(null);
  const [profile, setProfile] = useState<RestaurantProfile | null>(null);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  async function onResend() {
    if (!accessToken || resending) return;
    setResending(true);
    try {
      await resendVerification(accessToken, onNewToken);
      setResent(true);
      toast({ title: 'Confirmation email sent', variant: 'success' });
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not resend',
        variant: 'danger',
      });
    } finally {
      setResending(false);
    }
  }

  async function onSignOut() {
    // The button says "everywhere", so it must actually revoke every session.
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
    getRestaurantProfile(accessToken, onNewToken)
      .then(setProfile)
      .catch(() => undefined);
  }, [accessToken, onNewToken]);

  if (!me || !profile) {
    return (
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <div className="mt-6 max-w-xl space-y-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  const current = me.memberships[0];
  const canEdit = current?.role.key === 'OWNER';

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>

      <div className="mt-6 max-w-xl space-y-4">
        <Card>
          <CardHeader
            title="Profile"
            action={
              <Badge variant={me.user.emailVerified ? 'success' : 'warning'}>
                {me.user.emailVerified ? 'Email verified' : 'Email unverified'}
              </Badge>
            }
          />
          <dl className="space-y-3 text-sm">
            <Row label="Name" value={me.user.name} />
            <Row label="Email" value={me.user.email} />
          </dl>
          {!me.user.emailVerified && (
            <div className="mt-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5">
              <p className="text-[13px] text-warning-text">
                Confirm your email so you can recover your account if you&apos;re
                ever locked out.
              </p>
              <button
                type="button"
                onClick={() => void onResend()}
                disabled={resending || resent}
                className="mt-2 rounded-md border border-line-2 bg-surface px-3 py-1.5 text-[13px] font-medium transition-colors duration-120 hover:bg-surface-2 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
              >
                {resent
                  ? 'Sent — check your inbox'
                  : resending
                    ? 'Sending…'
                    : 'Resend confirmation email'}
              </button>
            </div>
          )}
        </Card>

        {canEdit ? (
          <RestaurantForm
            profile={profile}
            onSaved={setProfile}
            roleName={current?.role.name}
          />
        ) : (
          <Card>
            <CardHeader
              title="Restaurant"
              action={current && <Badge>{current.role.name}</Badge>}
            />
            <dl className="space-y-3 text-sm">
              <Row label="Name" value={profile.name} />
              <Row label="Address" value={profile.address ?? '—'} />
              <Row label="Phone" value={profile.phone ?? '—'} />
              <Row label="GSTIN" value={profile.gstin ?? '—'} />
              <Row label="FSSAI" value={profile.fssai ?? '—'} />
            </dl>
            <p className="mt-4 text-[12px] text-ink-3">
              Only the owner can edit the business profile.
            </p>
          </Card>
        )}

        <Card>
          <CardHeader title="Session" />
          <dl className="mb-4 space-y-3 text-sm">
            <Row label="Current Workspace" value={current?.restaurant.name ?? '—'} />
            <Row label="Role" value={current?.role.name ?? '—'} />
            <Row label="Workspaces" value={String(me.memberships.length)} />
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

function RestaurantForm({
  profile,
  onSaved,
  roleName,
}: {
  profile: RestaurantProfile;
  onSaved: (p: RestaurantProfile) => void;
  roleName?: string;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [name, setName] = useState(profile.name);
  const [address, setAddress] = useState(profile.address ?? '');
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [gstin, setGstin] = useState(profile.gstin ?? '');
  const [fssai, setFssai] = useState(profile.fssai ?? '');
  const [header, setHeader] = useState(profile.receiptHeader ?? '');
  const [footer, setFooter] = useState(profile.receiptFooter ?? '');
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !name.trim()) return;
    setBusy(true);
    try {
      const updated = await updateRestaurantProfile(accessToken, onNewToken, {
        name: name.trim(),
        address,
        phone,
        gstin,
        fssai,
        receiptHeader: header,
        receiptFooter: footer,
      });
      onSaved(updated);
      toast({ title: 'Business profile saved', variant: 'success' });
    } catch (err) {
      // Validation messages (bad GSTIN etc.) surface verbatim.
      toast({
        title: err instanceof ApiRequestError ? err.message : 'Could not save',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Restaurant"
        action={roleName && <Badge>{roleName}</Badge>}
      />
      <form onSubmit={save} className="space-y-4">
        <Field label="Business name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Address">
          <Textarea
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            maxLength={300}
            placeholder="Shop no, street, area, city, PIN"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone">
            <Input
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="9876543210"
            />
          </Field>
          <Field label="FSSAI licence">
            <Input
              inputMode="numeric"
              value={fssai}
              onChange={(e) => setFssai(e.target.value)}
              placeholder="14 digits"
            />
          </Field>
        </div>
        <Field label="GSTIN">
          <Input
            value={gstin}
            onChange={(e) => setGstin(e.target.value.toUpperCase())}
            placeholder="27AAPFU0939F1ZV"
            maxLength={15}
            className="font-mono uppercase"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Receipt header">
            <Input
              value={header}
              onChange={(e) => setHeader(e.target.value)}
              maxLength={200}
              placeholder="Shown above the bill"
            />
          </Field>
          <Field label="Receipt footer">
            <Input
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              maxLength={300}
              placeholder="Thank you, visit again!"
            />
          </Field>
        </div>
        <p className="text-[12px] text-ink-3">
          These details appear on printed receipts. Leave a field blank to keep
          it off the bill.
        </p>
        <Button type="submit" variant="primary" disabled={!name.trim() || busy}>
          {busy ? 'Saving…' : 'Save profile'}
        </Button>
      </form>
    </Card>
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
