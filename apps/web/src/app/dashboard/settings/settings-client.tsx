'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ApiRequestError,
  getLoyaltySettings,
  getMe,
  getRestaurantProfile,
  logout as apiLogout,
  logoutAll,
  resendVerification,
  updateLoyaltySettings,
  updateRestaurantProfile,
  type LoyaltySettings,
  type MeResponse,
  type RestaurantProfile,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatMinor, parseRupeesToMinor } from '@/lib/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
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
  // Null until known; a failed fetch (no loyalty.adjust permission) leaves it
  // null and the card is simply not shown — the API is the real boundary.
  const [loyalty, setLoyalty] = useState<LoyaltySettings | null>(null);
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
    getLoyaltySettings(accessToken, onNewToken)
      .then(setLoyalty)
      .catch(() => setLoyalty(null));
  }, [accessToken, onNewToken]);

  if (!me || !profile) {
    return (
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <div
          className="mt-6 max-w-xl space-y-4"
          role="status"
          aria-busy="true"
          aria-label="Loading settings"
        >
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

        {loyalty && (
          <LoyaltyForm settings={loyalty} onSaved={setLoyalty} />
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

/**
 * Loyalty rules (M13). Money fields are entered in rupees and stored in paise;
 * point fields are whole numbers. A live sentence restates the current values so
 * the owner sees exactly what a customer will experience before saving. When the
 * program is switched off, the rate fields dim — existing balances are untouched,
 * which the copy makes explicit. The server validates and is the real boundary.
 */
function LoyaltyForm({
  settings,
  onSaved,
}: {
  settings: LoyaltySettings;
  onSaved: (s: LoyaltySettings) => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  // Rupees for money, plain strings for point counts — parsed on save.
  const rupees = (minor: number) => (minor / 100).toString();
  const [enabled, setEnabled] = useState(settings.isEnabled);
  const [earnAmount, setEarnAmount] = useState(rupees(settings.earnAmountMinor));
  const [earnPoints, setEarnPoints] = useState(String(settings.earnPoints));
  const [redeemPoints, setRedeemPoints] = useState(String(settings.redeemPoints));
  const [redeemAmount, setRedeemAmount] = useState(rupees(settings.redeemAmountMinor));
  const [minRedeem, setMinRedeem] = useState(String(settings.minimumRedeemPoints));
  const [maxRedeem, setMaxRedeem] = useState(
    settings.maximumRedeemPointsPerOrder === null
      ? ''
      : String(settings.maximumRedeemPointsPerOrder),
  );
  const [busy, setBusy] = useState(false);

  // Parsed preview, used both for the live sentence and to disable an
  // impossible save. Money → paise via the shared helper; points → integers.
  const earnAmountMinor = parseRupeesToMinor(earnAmount);
  const redeemAmountMinor = parseRupeesToMinor(redeemAmount);
  const earnPts = Number(earnPoints);
  const redeemPts = Number(redeemPoints);
  const minPts = Number(minRedeem);
  const maxPts = maxRedeem.trim() === '' ? null : Number(maxRedeem);

  const intOk = (n: number, min: number) => Number.isInteger(n) && n >= min;
  const valid =
    earnAmountMinor !== null &&
    earnAmountMinor > 0 &&
    redeemAmountMinor !== null &&
    redeemAmountMinor >= 0 &&
    intOk(earnPts, 1) &&
    intOk(redeemPts, 1) &&
    intOk(minPts, 0) &&
    (maxPts === null || intOk(maxPts, 0));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !valid) return;
    setBusy(true);
    try {
      const updated = await updateLoyaltySettings(accessToken, onNewToken, {
        isEnabled: enabled,
        earnAmountMinor: earnAmountMinor!,
        earnPoints: earnPts,
        redeemPoints: redeemPts,
        redeemAmountMinor: redeemAmountMinor!,
        minimumRedeemPoints: minPts,
        maximumRedeemPointsPerOrder: maxPts,
      });
      onSaved(updated);
      toast({ title: 'Loyalty settings saved', variant: 'success' });
    } catch (err) {
      // Server validation messages (bad ratio etc.) surface verbatim.
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
        title="Loyalty"
        action={
          <Badge variant={enabled ? 'success' : 'neutral'}>
            {enabled ? 'Enabled' : 'Disabled'}
          </Badge>
        }
      />
      <form onSubmit={save} className="space-y-5">
        <div>
          <span className="text-label mb-1.5 block">Status</span>
          <Segmented
            options={[
              { key: 'on', label: 'Enabled' },
              { key: 'off', label: 'Disabled' },
            ]}
            value={enabled ? 'on' : 'off'}
            onChange={(v) => setEnabled(v === 'on')}
            className="max-w-fit"
          />
          {!enabled && (
            <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-ink-2">
              Loyalty is off: no points are earned or redeemed. Existing points
              and history are preserved.
            </p>
          )}
        </div>

        <fieldset
          disabled={!enabled}
          className="space-y-5 transition-opacity aria-disabled:opacity-50"
          aria-disabled={!enabled}
        >
          <div>
            <span className="text-label mb-1.5 block">Earn points</span>
            <div className="flex flex-wrap items-end gap-2 text-[13px] text-ink-2">
              <span>₹</span>
              <div className="w-24">
                <Input
                  inputMode="decimal"
                  value={earnAmount}
                  onChange={(e) => setEarnAmount(e.target.value)}
                  aria-label="Spend amount in rupees"
                />
              </div>
              <span>gives</span>
              <div className="w-20">
                <Input
                  inputMode="numeric"
                  value={earnPoints}
                  onChange={(e) => setEarnPoints(e.target.value)}
                  aria-label="Points earned"
                />
              </div>
              <span>points</span>
            </div>
          </div>

          <div>
            <span className="text-label mb-1.5 block">Redeem points</span>
            <div className="flex flex-wrap items-end gap-2 text-[13px] text-ink-2">
              <div className="w-20">
                <Input
                  inputMode="numeric"
                  value={redeemPoints}
                  onChange={(e) => setRedeemPoints(e.target.value)}
                  aria-label="Points to redeem"
                />
              </div>
              <span>points give ₹</span>
              <div className="w-24">
                <Input
                  inputMode="decimal"
                  value={redeemAmount}
                  onChange={(e) => setRedeemAmount(e.target.value)}
                  aria-label="Discount in rupees"
                />
              </div>
              <span>off</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Minimum redemption (points)">
              <Input
                inputMode="numeric"
                value={minRedeem}
                onChange={(e) => setMinRedeem(e.target.value)}
              />
            </Field>
            <Field label="Maximum per order (points)">
              <Input
                inputMode="numeric"
                value={maxRedeem}
                onChange={(e) => setMaxRedeem(e.target.value)}
                placeholder="No limit"
              />
            </Field>
          </div>
        </fieldset>

        {/* Live explanation — restates the rules in plain language as edited. */}
        {valid && enabled && (
          <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">
            Customers earn {earnPts} {earnPts === 1 ? 'point' : 'points'} for every{' '}
            {formatMinor(earnAmountMinor!)} spent. {redeemPts}{' '}
            {redeemPts === 1 ? 'point' : 'points'} can be redeemed for{' '}
            {formatMinor(redeemAmountMinor!)} off
            {minPts > 0 && `, from ${minPts} points`}
            {maxPts !== null && `, up to ${maxPts} per order`}.
          </p>
        )}

        <Button type="submit" variant="primary" disabled={!valid || busy}>
          {busy ? 'Saving…' : 'Save changes'}
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
