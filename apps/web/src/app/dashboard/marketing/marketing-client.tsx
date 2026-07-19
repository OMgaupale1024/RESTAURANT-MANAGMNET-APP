'use client';

import { useCallback, useEffect, useState } from 'react';
import { Lightbulb, TicketPercent, Users } from 'lucide-react';
import {
  ApiRequestError,
  createCoupon,
  getSegments,
  listCoupons,
  segmentCustomers,
  setCouponActive,
  type Coupon,
  type Segment,
  type SegmentCustomer,
  type SegmentsResponse,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatMinor } from '@/lib/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';

/**
 * Marketing — coupons (server-priced, redemption-capped) and the deterministic
 * customer segments. Segmentation is computed entirely server-side; this page
 * only displays what /marketing returns and never reclassifies a customer.
 */

const TABS = [
  { key: 'COUPONS', label: 'Coupons' },
  { key: 'SEGMENTS', label: 'Segments' },
] as const;

/** Segment visual identity — colour + accent, consistent with the profile chip. */
export const SEGMENT_VARIANT: Record<string, 'brand' | 'info' | 'success' | 'warning' | 'neutral'> = {
  VIP: 'brand',
  REGULAR: 'info',
  NEW: 'success',
  LAPSED: 'warning',
};

function couponDiscount(c: Coupon): string {
  if (c.type === 'PERCENT') {
    const pct = `${(c.percentBp ?? 0) / 100}% off`;
    return c.maxDiscountMinor ? `${pct} (max ${formatMinor(c.maxDiscountMinor)})` : pct;
  }
  return `${formatMinor(c.amountMinor ?? 0)} off`;
}

function couponValidity(c: Coupon): string {
  const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  if (c.validFrom && c.validUntil) return `${fmt(c.validFrom)} – ${fmt(c.validUntil)}`;
  if (c.validUntil) return `until ${fmt(c.validUntil)}`;
  if (c.validFrom) return `from ${fmt(c.validFrom)}`;
  return 'Always';
}

export function MarketingClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('COUPONS');
  const [coupons, setCoupons] = useState<Coupon[] | null>(null);
  const [segments, setSegments] = useState<SegmentsResponse | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmOff, setConfirmOff] = useState<Coupon | null>(null);
  const [openSegment, setOpenSegment] = useState<Segment | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    Promise.all([listCoupons(accessToken, onNewToken), getSegments(accessToken, onNewToken)])
      .then(([c, s]) => {
        if (cancelled) return;
        setCoupons(c);
        setSegments(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          toast({
            title: e instanceof ApiRequestError ? e.message : 'Could not load marketing',
            variant: 'danger',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, reloadKey, toast]);

  async function setActive(c: Coupon, isActive: boolean) {
    if (!accessToken) return;
    try {
      await setCouponActive(accessToken, onNewToken, c.id, isActive);
      toast({ title: isActive ? 'Coupon enabled' : 'Coupon disabled', variant: 'success' });
      reload();
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not update coupon',
        variant: 'danger',
      });
    }
  }

  const loadingCoupons = coupons === null;
  const list = coupons ?? [];
  const activeCount = list.filter((c) => c.isActive).length;
  const totalRedemptions = list.reduce((s, c) => s + (c._count?.redemptions ?? 0), 0);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Marketing</h1>
        <div className="flex items-center gap-3">
          <Segmented options={TABS} value={tab} onChange={setTab} />
          {tab === 'COUPONS' && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <TicketPercent aria-hidden className="size-4" />
              New coupon
            </Button>
          )}
        </div>
      </div>

      {tab === 'COUPONS' ? (
        <>
          {!loadingCoupons && list.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-3">
              <StatCard label="Coupons" value={list.length} format={String} />
              <StatCard label="Active" value={activeCount} format={String} />
              <StatCard label="Total redemptions" value={totalRedemptions} format={String} />
            </div>
          )}

          <div className="mt-4 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
            {loadingCoupons ? (
              <div className="space-y-2 p-4" aria-label="Loading coupons">
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="h-9" />
                ))}
              </div>
            ) : list.length === 0 ? (
              <EmptyState
                icon={TicketPercent}
                title="No coupons yet"
                body="Create a code and the POS will price the discount server-side at checkout."
                action={
                  <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
                    Create a coupon
                  </Button>
                }
              />
            ) : (
              <Table containerClassName="max-h-[calc(100dvh-20rem)] overflow-y-auto rounded-xl">
                <thead>
                  <tr>
                    <Th>Code</Th>
                    <Th>Discount</Th>
                    <Th className="hidden md:table-cell">Min order</Th>
                    <Th className="hidden sm:table-cell">Validity</Th>
                    <Th numeric>Redemptions</Th>
                    <Th>Status</Th>
                    <Th className="w-px" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {list.map((c) => {
                    const used = c._count?.redemptions ?? 0;
                    const exhausted = c.maxRedemptions !== null && used >= c.maxRedemptions;
                    return (
                      <Tr key={c.id} className="animate-fade-up">
                        <Td>
                          <span className="font-mono font-medium">{c.code}</span>
                        </Td>
                        <Td>{couponDiscount(c)}</Td>
                        <Td className="hidden text-ink-2 md:table-cell">
                          {c.minSubtotalMinor > 0 ? formatMinor(c.minSubtotalMinor) : '—'}
                        </Td>
                        <Td className="hidden text-ink-2 sm:table-cell">{couponValidity(c)}</Td>
                        <Td numeric className="tabular-nums">
                          {used}
                          {c.maxRedemptions !== null && (
                            <span className="text-ink-3"> / {c.maxRedemptions}</span>
                          )}
                        </Td>
                        <Td>
                          {c.isActive ? (
                            exhausted ? (
                              <Badge variant="neutral">Used up</Badge>
                            ) : (
                              <Badge variant="success">Active</Badge>
                            )
                          ) : (
                            <Badge variant="neutral">Disabled</Badge>
                          )}
                        </Td>
                        <Td className="py-1.5 text-right">
                          {c.isActive ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-danger-text"
                              onClick={() => setConfirmOff(c)}
                            >
                              Disable
                            </Button>
                          ) : (
                            <Button variant="secondary" size="sm" onClick={() => void setActive(c, true)}>
                              Enable
                            </Button>
                          )}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </div>
        </>
      ) : (
        <SegmentsTab
          segments={segments}
          onOpen={setOpenSegment}
        />
      )}

      <NewCouponModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          reload();
        }}
      />

      <ConfirmDialog
        open={confirmOff !== null}
        onClose={() => setConfirmOff(null)}
        onConfirm={() => {
          if (confirmOff) void setActive(confirmOff, false);
          setConfirmOff(null);
        }}
        title={confirmOff ? `Disable ${confirmOff.code}?` : 'Disable coupon?'}
        body="The code stops working immediately at the POS. Past redemptions stay on record and you can re-enable it later."
        confirmLabel="Disable coupon"
      />

      <SegmentSheet segment={openSegment} onClose={() => setOpenSegment(null)} />
    </div>
  );
}

function SegmentsTab({
  segments,
  onOpen,
}: {
  segments: SegmentsResponse | null;
  onOpen: (s: Segment) => void;
}) {
  if (!segments) {
    return (
      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4" aria-label="Loading segments">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {segments.segments.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => onOpen(s)}
            className="rounded-xl border border-line bg-surface p-5 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[border-color,transform] duration-120 hover:-translate-y-px hover:border-line-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
          >
            <Badge variant={SEGMENT_VARIANT[s.key] ?? 'neutral'}>{s.label}</Badge>
            <p className="mt-3 text-[28px] leading-none font-semibold tracking-tight tabular-nums">
              {s.count}
            </p>
            {/* The rule IS the feature — a segment is never a black box. */}
            <p className="mt-2 text-[12px] text-ink-3">{s.rule}</p>
          </button>
        ))}
      </div>

      {/* Recommendations — advisory only, labelled by method, never acting. */}
      {segments.recommendations.length > 0 && (
        <section>
          <h2 className="text-label mb-2">Suggestions</h2>
          <div className="space-y-3">
            {segments.recommendations.map((r, i) => (
              <Card key={i} className="flex gap-3">
                <Lightbulb aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-text" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{r.title}</span>
                    <Badge variant="info">Advisory</Badge>
                  </div>
                  <p className="mt-1 text-[13px] text-ink-2">{r.detail}</p>
                  <p className="mt-1.5 text-[12px] text-ink-3">Based on {r.basis}.</p>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SegmentSheet({ segment, onClose }: { segment: Segment | null; onClose: () => void }) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [customers, setCustomers] = useState<SegmentCustomer[] | null>(null);
  const key = segment?.key ?? null;

  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setCustomers(null);
  }

  useEffect(() => {
    if (!accessToken || !key) {
      return;
    }
    let cancelled = false;
    segmentCustomers(accessToken, onNewToken, key)
      .then((list) => {
        if (!cancelled) setCustomers(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          toast({
            title: e instanceof ApiRequestError ? e.message : 'Could not load segment',
            variant: 'danger',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, key, toast]);

  return (
    <Sheet
      open={segment !== null}
      onClose={onClose}
      title={
        segment ? (
          <span className="flex items-center gap-2.5">
            <Badge variant={SEGMENT_VARIANT[segment.key] ?? 'neutral'}>{segment.label}</Badge>
            <span className="text-ink-2">{segment.count} customer{segment.count === 1 ? '' : 's'}</span>
          </span>
        ) : (
          'Segment'
        )
      }
    >
      {segment && <p className="mb-4 text-[12px] text-ink-3">{segment.rule}</p>}
      {customers === null ? (
        <div className="space-y-2" aria-label="Loading customers">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : customers.length === 0 ? (
        <EmptyState icon={Users} title="No customers here" body="No customers currently match this segment's rule." />
      ) : (
        <ul className="space-y-2">
          {customers.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2.5 text-[13px]"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{c.name}</span>
                <span className="block font-mono text-[12px] text-ink-3 tabular-nums">{c.phone}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

const COUPON_TYPES = [
  { key: 'PERCENT', label: 'Percent' },
  { key: 'FIXED', label: 'Fixed ₹' },
] as const;

/** YYYY-MM-DD (native date input) → ISO8601 the coupon DTO accepts. */
const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const dayEnd = (d: string) => (d ? new Date(`${d}T23:59:59`).toISOString() : undefined);

function NewCouponModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [code, setCode] = useState('');
  const [type, setType] = useState<'PERCENT' | 'FIXED'>('PERCENT');
  const [value, setValue] = useState('');
  const [maxDiscount, setMaxDiscount] = useState('');
  const [minOrder, setMinOrder] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [busy, setBusy] = useState(false);

  const num = Number(value);
  const rangeBad = validFrom && validUntil && validFrom > validUntil;
  const valid =
    /^[A-Z0-9]{3,32}$/.test(code.trim()) && Number.isFinite(num) && num > 0 && !rangeBad;

  function reset() {
    setCode('');
    setType('PERCENT');
    setValue('');
    setMaxDiscount('');
    setMinOrder('');
    setMaxRedemptions('');
    setValidFrom('');
    setValidUntil('');
  }

  const toMinor = (s: string) => (s.trim() ? Math.round(Number(s) * 100) : undefined);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !valid) return;
    setBusy(true);
    try {
      await createCoupon(accessToken, onNewToken, {
        code: code.trim(),
        type,
        // PERCENT: whole percent → basis points. FIXED: rupees → paise. The
        // server re-validates everything; the client never prices an order.
        ...(type === 'PERCENT'
          ? { percentBp: Math.round(num * 100), ...(toMinor(maxDiscount) ? { maxDiscountMinor: toMinor(maxDiscount) } : {}) }
          : { amountMinor: Math.round(num * 100) }),
        ...(toMinor(minOrder) ? { minSubtotalMinor: toMinor(minOrder) } : {}),
        ...(maxRedemptions.trim() ? { maxRedemptions: Math.round(Number(maxRedemptions)) } : {}),
        ...(dayStart(validFrom) ? { validFrom: dayStart(validFrom) } : {}),
        ...(dayEnd(validUntil) ? { validUntil: dayEnd(validUntil) } : {}),
      });
      toast({ title: `Coupon ${code.trim()} created`, variant: 'success' });
      reset();
      onCreated();
    } catch (err) {
      toast({
        title: err instanceof ApiRequestError ? err.message : 'Could not create coupon',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New coupon">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={32}
              placeholder="DIWALI10"
              className="font-mono"
            />
          </Field>
          <Field label="Type">
            <div className="pt-0.5">
              <Segmented options={COUPON_TYPES} value={type} onChange={setType} />
            </div>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label={type === 'PERCENT' ? 'Percent off' : 'Rupees off'}>
            <Input
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={type === 'PERCENT' ? '10' : '50'}
            />
          </Field>
          {type === 'PERCENT' ? (
            <Field label="Max discount ₹ (optional)">
              <Input
                inputMode="decimal"
                value={maxDiscount}
                onChange={(e) => setMaxDiscount(e.target.value)}
                placeholder="e.g. 100"
              />
            </Field>
          ) : (
            <Field label="Min order ₹ (optional)">
              <Input
                inputMode="decimal"
                value={minOrder}
                onChange={(e) => setMinOrder(e.target.value)}
                placeholder="e.g. 300"
              />
            </Field>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          {type === 'PERCENT' && (
            <Field label="Min order ₹ (optional)">
              <Input
                inputMode="decimal"
                value={minOrder}
                onChange={(e) => setMinOrder(e.target.value)}
                placeholder="e.g. 300"
              />
            </Field>
          )}
          <Field label="Usage limit (optional)">
            <Input
              inputMode="numeric"
              value={maxRedemptions}
              onChange={(e) => setMaxRedemptions(e.target.value)}
              placeholder="e.g. 100"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Valid from (optional)">
            <Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
          </Field>
          <Field label="Valid until (optional)" error={rangeBad ? 'Must be after start' : undefined}>
            <Input
              type="date"
              value={validUntil}
              error={Boolean(rangeBad)}
              onChange={(e) => setValidUntil(e.target.value)}
            />
          </Field>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!valid || busy}>
            {busy ? 'Creating…' : 'Create coupon'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
