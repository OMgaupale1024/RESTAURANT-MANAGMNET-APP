'use client';

import { useEffect, useState } from 'react';
import { Search, UserRoundPlus } from 'lucide-react';
import {
  ApiRequestError,
  createCustomer,
  listCustomers,
  type CustomerSummary,
} from '@/lib/api';
import { formatMinor } from '@/lib/money';
import { validPhone } from '@/lib/phone';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { SegmentChip } from '@/components/ui/segment-chip';
import type { PosCustomer } from './customer-picker';

type Retry = (t: string) => void;

/**
 * Optional customer lookup at the till — the fuller flow behind the "Add
 * customer" button. Search by phone OR name (one debounced call to the same
 * endpoint the Customers screen uses, which already returns visits, spend and
 * the marketing segment), preview and attach, or create a customer inline when
 * there is no match. Guest checkout is always one button away and never forced.
 *
 * There is deliberately no loyalty tier / points here — no such program exists
 * yet (see docs/ROADMAP_V2.md, Milestone 2). The segment, visits and spend are
 * the real signals the data already carries.
 */
export function CustomerDialog({
  open,
  onClose,
  accessToken,
  onNewToken,
  onAttach,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  accessToken: string | null;
  onNewToken: Retry;
  onAttach: (customer: PosCustomer) => void;
  onError: (message: string) => void;
}) {
  const [q, setQ] = useState('');
  // null means "a search is pending for the current query" (during the debounce
  // and while in flight). An array — including [] — is a settled result.
  const [results, setResults] = useState<CustomerSummary[] | null>(null);
  const [creating, setCreating] = useState(false);

  // Debounced search: one request per pause, not per keystroke — same rule as
  // the Customers screen. State is only set from async callbacks here, never
  // synchronously in the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    const query = q.trim();
    if (!open || !accessToken || !query) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      listCustomers(accessToken, onNewToken, query)
        .then((list) => {
          if (!cancelled) setResults(list);
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setResults([]);
            onError(e instanceof ApiRequestError ? e.message : 'Lookup failed');
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, accessToken, q, onNewToken, onError]);

  // Reset here, on the event, rather than in an effect — every close path
  // (Esc, backdrop, the button) routes through the Modal's onClose.
  function handleClose() {
    setQ('');
    setResults(null);
    setCreating(false);
    onClose();
  }

  function attach(c: CustomerSummary) {
    onAttach({
      id: c.id,
      name: c.name,
      phone: c.phone,
      segment: c.segment,
      visits: c.stats.visits,
      totalSpentMinor: c.stats.totalSpentMinor,
    });
  }

  const trimmed = q.trim();
  const pending = trimmed !== '' && results === null;
  const noMatch = results !== null && results.length === 0 && trimmed !== '';

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={creating ? 'New customer' : 'Add customer'}
    >
      {creating ? (
        <CreateForm
          accessToken={accessToken}
          onNewToken={onNewToken}
          // If the search looked like a phone, prefill it there; otherwise it
          // was probably a name. Small courtesy, no wrong guess costs anything.
          initialPhone={validPhone(trimmed) ? trimmed : ''}
          initialName={validPhone(trimmed) ? '' : trimmed}
          onError={onError}
          onBack={() => setCreating(false)}
          onCreated={onAttach}
        />
      ) : (
        <div className="space-y-3">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3"
            />
            <Input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                // Back to "pending" for the new query until the debounce settles.
                setResults(null);
              }}
              onKeyDown={(e) => {
                // Enter attaches the top match — search, enter, done.
                if (e.key === 'Enter' && results && results.length > 0) {
                  e.preventDefault();
                  attach(results[0]);
                }
              }}
              placeholder="Search by phone or name…"
              aria-label="Search customers by phone or name"
              className="pl-9"
            />
          </div>

          <div className="min-h-[8rem]">
            {trimmed === '' ? (
              <p className="px-2 py-10 text-center text-[13px] text-ink-3">
                Search by phone or name to attach a customer — or continue as
                guest.
              </p>
            ) : pending ? (
              <p
                className="px-2 py-10 text-center text-[13px] text-ink-3"
                role="status"
                aria-live="polite"
              >
                Searching…
              </p>
            ) : noMatch ? (
              <p className="px-2 py-10 text-center text-[13px] text-ink-2">
                No customer found for “{trimmed}”. Create one, or continue as
                guest.
              </p>
            ) : (
              <ul
                className="max-h-64 space-y-1 overflow-y-auto"
                aria-label="Search results"
              >
                {(results ?? []).map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => attach(c)}
                      className="flex w-full items-center gap-3 rounded-lg border border-line px-3 py-2 text-left transition-colors duration-120 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                    >
                      <div className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium">
                            {c.name}
                          </span>
                          {c.segment && <SegmentChip segment={c.segment} />}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-ink-3 tabular-nums">
                          {c.phone} · {c.stats.visits} visit
                          {c.stats.visits === 1 ? '' : 's'} ·{' '}
                          {formatMinor(c.stats.totalSpentMinor)}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setCreating(true)}
            >
              <UserRoundPlus aria-hidden className="size-4" />
              New customer
            </Button>
            <Button variant="ghost" size="sm" onClick={handleClose}>
              Continue as guest
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Inline create step — same fields and endpoint as the Customers screen. */
function CreateForm({
  accessToken,
  onNewToken,
  initialName,
  initialPhone,
  onCreated,
  onBack,
  onError,
}: {
  accessToken: string | null;
  onNewToken: Retry;
  initialName: string;
  initialPhone: string;
  onCreated: (customer: PosCustomer) => void;
  onBack: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState(initialPhone);
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
      // A brand-new customer has no history yet — no segment, no spend.
      onCreated({
        id: created.id,
        name: created.name,
        phone: created.phone,
        segment: null,
        visits: 0,
        totalSpentMinor: 0,
      });
    } catch (err) {
      onError(
        err instanceof ApiRequestError ? err.message : 'Could not add customer',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Name">
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
        />
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
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" type="button" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" type="submit" disabled={!valid || busy}>
          {busy ? 'Adding…' : 'Add & attach'}
        </Button>
      </div>
    </form>
  );
}
