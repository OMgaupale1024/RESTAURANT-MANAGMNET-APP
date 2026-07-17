'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiRequestError,
  createCoupon,
  getSegments,
  listCoupons,
  setCouponActive,
  type Coupon,
  type SegmentsResponse,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatMinor } from '@/lib/money';

export function MarketingClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);

  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [segments, setSegments] = useState<SegmentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const [c, s] = await Promise.all([
          listCoupons(accessToken, onNewToken),
          getSegments(accessToken, onNewToken),
        ]);
        if (!cancelled) {
          setCoupons(c);
          setSegments(s);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiRequestError ? e.message : 'Could not load marketing');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, reloadKey]);

  async function toggle(c: Coupon) {
    if (!accessToken) return;
    setError(null);
    try {
      await setCouponActive(accessToken, onNewToken, c.id, !c.isActive);
      reload();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Could not update');
    }
  }

  function describe(c: Coupon): string {
    const off =
      c.type === 'PERCENT'
        ? `${(c.percentBp ?? 0) / 100}% off`
        : `${formatMinor(c.amountMinor ?? 0)} off`;
    const min = c.minSubtotalMinor > 0 ? ` (min ${formatMinor(c.minSubtotalMinor)})` : '';
    return off + min;
  }

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Marketing</h1>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      )}

      {/* Recommendations — advisory, clearly labelled by method, never acting. */}
      {segments && segments.recommendations.length > 0 && (
        <div className="mt-4 space-y-2">
          {segments.recommendations.map((r, i) => (
            <div
              key={i}
              className="rounded-lg border border-orange-500/40 bg-orange-500/5 p-4"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">{r.title}</span>
                <span className="rounded bg-black/10 px-2 py-0.5 text-[10px] font-medium uppercase text-black/60 dark:bg-white/15 dark:text-white/60">
                  Rule
                </span>
              </div>
              <p className="mt-1 text-sm text-black/70 dark:text-white/70">{r.detail}</p>
              <p className="mt-2 text-xs text-black/50 dark:text-white/50">
                Based on: {r.basis}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_18rem]">
        <section aria-labelledby="coupons-heading">
          <h2 id="coupons-heading" className="text-sm font-medium">
            Coupons
          </h2>
          {coupons.length === 0 ? (
            <p className="mt-3 rounded-lg border border-black/10 p-6 text-sm text-black/60 dark:border-white/15 dark:text-white/60">
              No coupons yet.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/15 dark:border-white/15">
              {coupons.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
                  <code className="rounded bg-black/5 px-2 py-0.5 font-mono dark:bg-white/10">
                    {c.code}
                  </code>
                  <span>{describe(c)}</span>
                  {!c.isActive && (
                    <span className="rounded bg-black/10 px-2 py-0.5 text-xs dark:bg-white/15">
                      Inactive
                    </span>
                  )}
                  <span className="ml-auto text-xs text-black/50 dark:text-white/50">
                    {c._count?.redemptions ?? 0} used
                    {c.maxRedemptions ? ` / ${c.maxRedemptions}` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggle(c)}
                    className="rounded border border-black/20 px-2 py-1 text-xs dark:border-white/25"
                  >
                    {c.isActive ? 'Disable' : 'Enable'}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-black/60 dark:text-white/60">
              Create a coupon
            </summary>
            <CouponForm
              accessToken={accessToken}
              onNewToken={onNewToken}
              onCreated={reload}
              setError={setError}
            />
          </details>
        </section>

        <section
          aria-labelledby="segments-heading"
          className="rounded-lg border border-black/10 p-4 dark:border-white/15"
        >
          <h2 id="segments-heading" className="text-sm font-medium">
            Customer segments
          </h2>
          <p className="mt-1 text-xs text-black/50 dark:text-white/50">
            Deterministic. Each rule is shown.
          </p>
          {!segments ? (
            <p className="mt-3 text-sm text-black/50 dark:text-white/50">Loading…</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {segments.segments.map((s) => (
                <li key={s.key} className="flex items-baseline justify-between gap-2">
                  <span>
                    <span className="text-sm font-medium">{s.label}</span>
                    <span className="ml-1 block text-[11px] text-black/50 dark:text-white/50">
                      {s.rule}
                    </span>
                  </span>
                  <span className="text-lg font-semibold tabular-nums">{s.count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function CouponForm({
  accessToken,
  onNewToken,
  onCreated,
  setError,
}: {
  accessToken: string | null;
  onNewToken: (t: string) => void;
  onCreated: () => void;
  setError: (m: string | null) => void;
}) {
  const [code, setCode] = useState('');
  const [type, setType] = useState<'PERCENT' | 'FIXED'>('PERCENT');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const num = Number(value);
  const valid = code.trim().length >= 3 && Number.isFinite(num) && num > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !valid) return;
    setBusy(true);
    setError(null);
    try {
      await createCoupon(accessToken, onNewToken, {
        code: code.trim(),
        type,
        // PERCENT takes a whole-percent input -> basis points. FIXED takes
        // rupees -> paise. The server re-validates all of it.
        ...(type === 'PERCENT'
          ? { percentBp: Math.round(num * 100) }
          : { amountMinor: Math.round(num * 100) }),
      });
      setCode('');
      setValue('');
      onCreated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not create');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
      <div className="w-32">
        <label htmlFor="c-code" className="block text-xs font-medium">
          Code
        </label>
        <input
          id="c-code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={32}
          placeholder="DIWALI10"
          className="mt-1 w-full rounded-md border border-black/20 bg-transparent px-3 py-2 text-sm dark:border-white/25"
        />
      </div>
      <div className="w-28">
        <label htmlFor="c-type" className="block text-xs font-medium">
          Type
        </label>
        <select
          id="c-type"
          value={type}
          onChange={(e) => setType(e.target.value as 'PERCENT' | 'FIXED')}
          className="mt-1 w-full rounded-md border border-black/20 bg-transparent px-2 py-2 text-sm dark:border-white/25"
        >
          <option value="PERCENT">Percent</option>
          <option value="FIXED">Fixed ₹</option>
        </select>
      </div>
      <div className="w-24">
        <label htmlFor="c-value" className="block text-xs font-medium">
          {type === 'PERCENT' ? '% off' : '₹ off'}
        </label>
        <input
          id="c-value"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-1 w-full rounded-md border border-black/20 bg-transparent px-3 py-2 text-sm dark:border-white/25"
        />
      </div>
      <button
        type="submit"
        disabled={!valid || busy}
        className="rounded-md border border-black/20 px-3 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/25"
      >
        Create
      </button>
    </form>
  );
}
