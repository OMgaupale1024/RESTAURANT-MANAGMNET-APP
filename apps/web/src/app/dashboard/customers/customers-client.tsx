'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Search, SearchX, UserRoundPlus, UsersRound } from 'lucide-react';
import {
  ApiRequestError,
  createCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
  type CustomerDetail,
  type CustomerSummary,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { downloadCsv, minorToCsv, toCsv } from '@/lib/csv';
import { formatMinor } from '@/lib/money';
import { StatusBadge, timeShort } from '../orders/order-detail';

/** Customer list → CSV. Names go through toCsv's injection-safe escaping. */
function exportCustomersCsv(list: CustomerSummary[]) {
  const csv = toCsv(
    ['Name', 'Phone', 'Email', 'Visits', 'Total spend (INR)', 'Avg bill (INR)', 'Last visit', 'Segment'],
    list.map((c) => [
      c.name,
      c.phone,
      c.email ?? '',
      c.stats.visits,
      minorToCsv(c.stats.totalSpentMinor),
      minorToCsv(c.stats.averageBillMinor),
      c.stats.lastVisit ? c.stats.lastVisit.slice(0, 10) : '',
      c.segment?.label ?? '',
    ]),
  );
  downloadCsv(`customers-${new Date().toISOString().slice(0, 10)}.csv`, csv);
}
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';

/**
 * Customers — the CRM read over data the till already captures. Stats are
 * server-derived (voided orders excluded); nothing here is fabricated.
 */

function dayShort(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Mirrors the server rule (7-15 digits). The server re-validates regardless. */
const validPhone = (raw: string) => {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
};

/**
 * Segment colour identity — presentation only. The segment itself is classified
 * server-side (one shared classifier) and arrives on the customer payload; this
 * page never reclassifies anyone.
 */
const SEGMENT_VARIANT: Record<string, 'brand' | 'info' | 'success' | 'warning' | 'neutral'> = {
  VIP: 'brand',
  REGULAR: 'info',
  NEW: 'success',
  LAPSED: 'warning',
};

function SegmentChip({ segment }: { segment: { key: string; label: string } }) {
  return <Badge variant={SEGMENT_VARIANT[segment.key] ?? 'neutral'}>{segment.label}</Badge>;
}

export function CustomersClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [rows, setRows] = useState<CustomerSummary[] | null>(null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const tokenRef = useRef(accessToken);
  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    // Debounced: a keystroke per request would hammer the API.
    const timer = setTimeout(() => {
      listCustomers(accessToken, onNewToken, q.trim() || undefined)
        .then((list) => {
          if (!cancelled) setRows(list);
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            toast({
              title: e instanceof ApiRequestError ? e.message : 'Could not load customers',
              variant: 'danger',
            });
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [accessToken, onNewToken, q, reloadKey, toast]);

  const open = useCallback(
    (id: string) => {
      const token = tokenRef.current;
      if (!token) return;
      setSelectedId(id);
      setDetail(null);
      getCustomer(token, onNewToken, id)
        .then(setDetail)
        .catch((e: unknown) => {
          setSelectedId(null);
          toast({
            title: e instanceof ApiRequestError ? e.message : 'Could not open customer',
            variant: 'danger',
          });
        });
    },
    [onNewToken, toast],
  );

  function close() {
    setSelectedId(null);
    setDetail(null);
  }

  const loading = rows === null;
  const list = rows ?? [];
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const newThisMonth = list.filter((c) => new Date(c.createdAt) >= monthStart).length;
  const repeat = list.filter((c) => c.stats.visits > 1).length;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Customers</h1>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            disabled={list.length === 0}
            onClick={() => exportCustomersCsv(list)}
          >
            <Download aria-hidden className="size-4" />
            Export CSV
          </Button>
          <Button variant="primary" onClick={() => setAdding(true)}>
            <UserRoundPlus aria-hidden className="size-4" />
            New customer
          </Button>
        </div>
      </div>

      {!loading && list.length > 0 && !q && (
        <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-3">
          <StatCard label="Customers" value={list.length} format={String} />
          <StatCard label="New this month" value={newThisMonth} format={String} />
          <StatCard label="Repeat customers" value={repeat} format={String} />
        </div>
      )}

      <div className="relative mt-4 max-w-xs">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3"
        />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQ('');
          }}
          placeholder="Name or phone…"
          aria-label="Search customers"
          className="pl-9"
        />
      </div>

      <div className="mt-4 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
        {loading ? (
          <div className="space-y-2 p-4" aria-label="Loading customers">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : list.length === 0 ? (
          q ? (
            <EmptyState
              icon={SearchX}
              title="No matching customers"
              body="Search matches names and phone numbers."
            />
          ) : (
            <EmptyState
              icon={UsersRound}
              title="No customers yet"
              body="Attach a phone number at the POS and the customer appears here with their history."
              action={
                <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
                  Add a customer
                </Button>
              }
            />
          )
        ) : (
          <Table containerClassName="max-h-[calc(100dvh-22rem)] overflow-y-auto rounded-xl">
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th className="hidden sm:table-cell">Phone</Th>
                <Th numeric>Visits</Th>
                <Th numeric>Total spend</Th>
                <Th numeric className="hidden md:table-cell">
                  Avg bill
                </Th>
                <Th className="hidden sm:table-cell">Last visit</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <Tr
                  key={c.id}
                  onClick={() => open(c.id)}
                  aria-selected={selectedId === c.id}
                  className={cn('animate-fade-up', selectedId === c.id && 'bg-surface-2')}
                >
                  <Td>
                    <span className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          open(c.id);
                        }}
                        className="rounded font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                      >
                        {c.name}
                      </button>
                      {c.segment && <SegmentChip segment={c.segment} />}
                    </span>
                  </Td>
                  <Td className="hidden font-mono text-ink-2 tabular-nums sm:table-cell">
                    {c.phone}
                  </Td>
                  <Td numeric>{c.stats.visits}</Td>
                  <Td numeric className="font-medium">
                    {formatMinor(c.stats.totalSpentMinor)}
                  </Td>
                  <Td numeric className="hidden md:table-cell">
                    {c.stats.visits > 0 ? formatMinor(c.stats.averageBillMinor) : '—'}
                  </Td>
                  <Td className="hidden text-ink-2 sm:table-cell">
                    {dayShort(c.stats.lastVisit)}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
      {!loading && list.length >= 100 && (
        <p className="mt-2 text-[12px] text-ink-3">
          Showing the first 100 — search to narrow.
        </p>
      )}

      <Sheet
        open={selectedId !== null}
        onClose={close}
        title={detail ? detail.name : 'Customer'}
      >
        {!detail ? (
          <div className="space-y-3" aria-label="Loading customer">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-24" />
            <Skeleton className="h-40" />
          </div>
        ) : (
          <CustomerSheet
            detail={detail}
            onSaved={(fresh) => {
              setDetail(fresh);
              reload();
            }}
          />
        )}
      </Sheet>

      <AddCustomerModal
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(id) => {
          setAdding(false);
          reload();
          open(id);
        }}
      />
    </div>
  );
}

function CustomerSheet({
  detail,
  onSaved,
}: {
  detail: CustomerDetail;
  onSaved: (fresh: CustomerDetail) => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: detail.name,
    phone: detail.phone,
    email: detail.email ?? '',
    birthday: detail.birthday ? detail.birthday.slice(0, 10) : '',
    notes: detail.notes ?? '',
  });

  async function save() {
    if (!accessToken) return;
    const digits = validPhone(form.phone);
    if (!form.name.trim() || !digits) {
      toast({ title: 'Name and a 7–15 digit phone are required', variant: 'warning' });
      return;
    }
    setBusy(true);
    try {
      await updateCustomer(accessToken, onNewToken, detail.id, {
        name: form.name.trim(),
        phone: digits,
        email: form.email.trim() || null,
        birthday: form.birthday || null,
        notes: form.notes.trim() || null,
      });
      const fresh = await getCustomer(accessToken, onNewToken, detail.id);
      toast({ title: 'Customer updated', variant: 'success' });
      setEditing(false);
      onSaved(fresh);
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not save',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="space-y-4">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Phone">
          <Input
            inputMode="tel"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </Field>
        <Field label="Email">
          <Input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </Field>
        <Field label="Birthday">
          <Input
            type="date"
            value={form.birthday}
            onChange={(e) => setForm({ ...form, birthday: e.target.value })}
          />
        </Field>
        <Field label="Notes">
          <Textarea
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="Allergies, preferences, anything the till should know…"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="font-mono text-[13px] text-ink-2 tabular-nums">{detail.phone}</p>
        {detail.email && <p className="mt-0.5 text-[13px] text-ink-2">{detail.email}</p>}
        <p className="mt-0.5 text-[12px] text-ink-3">
          Customer since {dayShort(detail.createdAt)}
          {detail.birthday && ` · birthday ${dayShort(detail.birthday)}`}
        </p>
        {detail.segment && (
          <p className="mt-2 flex flex-wrap items-center gap-2">
            <SegmentChip segment={detail.segment} />
            <span className="text-[12px] text-ink-3">{detail.segment.rule}</span>
          </p>
        )}
      </div>

      <section>
        <h3 className="text-label mb-2">Spend</h3>
        <dl className="grid grid-cols-2 gap-3">
          <SheetStat label="Visits" value={String(detail.stats.visits)} />
          <SheetStat label="Total spent" value={formatMinor(detail.stats.totalSpentMinor)} />
          <SheetStat label="Average bill" value={formatMinor(detail.stats.averageBillMinor)} />
          <SheetStat label="Last visit" value={dayShort(detail.stats.lastVisit)} />
        </dl>
        {detail.stats.firstVisit && (
          <p className="mt-2 text-[12px] text-ink-3">
            First visit {dayShort(detail.stats.firstVisit)}
          </p>
        )}
      </section>

      <section>
        <h3 className="text-label mb-2">Order history</h3>
        {detail.recentOrders.length === 0 ? (
          <p className="text-[13px] text-ink-3">No orders yet.</p>
        ) : (
          <ul className="space-y-2">
            {/* Voided orders stay visible but are not counted as spend —
                the history is honest either way. */}
            {detail.recentOrders.map((o) => (
              <li key={o.id}>
                <a
                  href={`/dashboard/orders?id=${o.id}`}
                  className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-[13px] transition-colors duration-120 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                >
                  <span className="font-mono font-medium tabular-nums">#{o.orderNumber}</span>
                  <StatusBadge status={o.status} />
                  <span className="ml-auto text-ink-3">{timeShort(o.createdAt)}</span>
                  <span className="font-medium tabular-nums">{formatMinor(o.totalMinor)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail.notes && (
        <section>
          <h3 className="text-label mb-2">Notes</h3>
          <p className="text-[13px] whitespace-pre-wrap text-ink-2">{detail.notes}</p>
        </section>
      )}

      <Button variant="secondary" onClick={() => setEditing(true)}>
        Edit customer
      </Button>
    </div>
  );
}

function SheetStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2.5">
      <dt className="text-[11px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function AddCustomerModal({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (id: string) => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const digits = validPhone(phone);
  const valid = name.trim().length > 0 && digits !== null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !valid || !digits) return;
    setBusy(true);
    try {
      const created = await createCustomer(accessToken, onNewToken, {
        name: name.trim(),
        phone: digits,
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      toast({ title: `${created.name} added`, variant: 'success' });
      setName('');
      setPhone('');
      setEmail('');
      onAdded(created.id);
    } catch (err) {
      toast({
        title: err instanceof ApiRequestError ? err.message : 'Could not add customer',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New customer">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Phone">
          <Input
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="9876543210"
          />
        </Field>
        <Field label="Email (optional)">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!valid || busy}>
            {busy ? 'Adding…' : 'Add customer'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
