'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ClipboardCheck, ClipboardList } from 'lucide-react';
import {
  ApiRequestError,
  cancelStockCount,
  getStockCount,
  listStockCounts,
  startStockCount,
  submitStockCount,
  type StockCountDetail,
  type StockCountLine,
  type StockCountReason,
  type StockCountRow,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatQuantity, unitLabel } from '@/lib/units';
import { timeShort } from '../../orders/order-detail';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';

/**
 * Stock count — the physical-count workflow (M10). The maths and ledger live on
 * the server: the client starts a count (the backend snapshots system stock),
 * collects what staff physically counted, previews each difference against the
 * live stock the backend returned, and submits. The frontend never mutates
 * inventory — submit is the only write, and the server reconciles against LIVE
 * stock inside a locked transaction, so a sale mid-count is never double-counted.
 *
 * Mobile-first: one card per item, large numeric inputs, a sticky submit bar.
 */

const REASONS: { key: StockCountReason; label: string }[] = [
  { key: 'WASTE_SPOILAGE', label: 'Waste / spoilage' },
  { key: 'COUNTING_ERROR', label: 'Counting error' },
  { key: 'DAMAGED', label: 'Damaged' },
  { key: 'THEFT', label: 'Theft / missing stock' },
  { key: 'UNRECORDED_USAGE', label: 'Unrecorded usage' },
  { key: 'RECEIVING_DISCREPANCY', label: 'Receiving discrepancy' },
  { key: 'OTHER', label: 'Other' },
];

const STATUS_META: Record<
  StockCountRow['status'],
  { label: string; variant: 'success' | 'warning' | 'neutral' }
> = {
  OPEN: { label: 'In progress', variant: 'warning' },
  COMPLETED: { label: 'Completed', variant: 'success' },
  CANCELLED: { label: 'Cancelled', variant: 'neutral' },
};

/** What a staff member has entered for one line, kept purely local until submit. */
type Entry = { counted: string; reason: StockCountReason | '' };

/** Parse a counted field to a non-negative whole base-unit quantity, or null. */
function parseCounted(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export function StockCountClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();
  const router = useRouter();

  const [history, setHistory] = useState<StockCountRow[] | null>(null);
  const [detail, setDetail] = useState<StockCountDetail | null>(null);
  const [starting, setStarting] = useState(false);

  const reloadHistory = useCallback(() => {
    if (!accessToken) return;
    listStockCounts(accessToken, onNewToken)
      .then(setHistory)
      .catch((e: unknown) => {
        toast({
          title: e instanceof ApiRequestError ? e.message : 'Could not load counts',
          variant: 'danger',
        });
      });
  }, [accessToken, onNewToken, toast]);

  useEffect(() => {
    reloadHistory();
  }, [reloadHistory]);

  // Start (or resume) — the backend takes the system-stock snapshot; we consume
  // it, never compute the starting quantity in the browser.
  const start = useCallback(async () => {
    if (!accessToken) return;
    setStarting(true);
    try {
      const d = await startStockCount(accessToken, onNewToken, {});
      setDetail(d);
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not start the count',
        variant: 'danger',
      });
    } finally {
      setStarting(false);
    }
  }, [accessToken, onNewToken, toast]);

  const open = useCallback(
    async (id: string) => {
      if (!accessToken) return;
      try {
        setDetail(await getStockCount(accessToken, onNewToken, id));
      } catch (e) {
        toast({
          title: e instanceof ApiRequestError ? e.message : 'Could not open the count',
          variant: 'danger',
        });
      }
    },
    [accessToken, onNewToken, toast],
  );

  if (detail) {
    return (
      <CountSheet
        detail={detail}
        onBack={() => {
          setDetail(null);
          reloadHistory();
        }}
        onSubmitted={setDetail}
      />
    );
  }

  const openCount = history?.find((c) => c.status === 'OPEN');

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Stock count</h1>
          <p className="mt-1 text-[13px] text-ink-3">
            Count what is physically on the shelf. Any gap becomes a single
            correction on the stock ledger.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => router.push('/dashboard/inventory')}>
          <ArrowLeft aria-hidden className="size-4" />
          Inventory
        </Button>
      </div>

      {openCount ? (
        <div className="mt-5 rounded-xl border border-warning/40 bg-warning/10 p-4">
          <p className="text-sm font-medium">A count is already in progress</p>
          <p className="mt-1 text-[13px] text-ink-2">
            Started {timeShort(openCount.startedAt)} · {openCount._count.lines} items.
            Resume it rather than starting a new one.
          </p>
          <Button
            variant="primary"
            className="mt-3"
            onClick={() => void open(openCount.id)}
          >
            Resume count
          </Button>
        </div>
      ) : (
        <div className="mt-5">
          <Button variant="primary" size="lg" disabled={starting} onClick={() => void start()}>
            <ClipboardList aria-hidden className="size-4" />
            {starting ? 'Starting…' : 'Start a new count'}
          </Button>
        </div>
      )}

      <section className="mt-8">
        <h2 className="text-label mb-2">Recent counts</h2>
        {history === null ? (
          <div className="space-y-2" role="status" aria-busy="true" aria-label="Loading counts">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : history.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title="No counts yet"
            body="Start a count to reconcile what is on the shelf with what the system thinks you have."
          />
        ) : (
          <ul className="space-y-2">
            {history.map((c) => {
              const meta = STATUS_META[c.status];
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => void open(c.id)}
                    className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[13px] font-medium">{c.code}</p>
                      <p className="mt-0.5 text-[12px] text-ink-3">
                        {c._count.lines} items ·{' '}
                        {c.completedAt
                          ? `done ${timeShort(c.completedAt)}`
                          : `started ${timeShort(c.startedAt)}`}
                      </p>
                    </div>
                    <Badge variant={meta.variant}>{meta.label}</Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function CountSheet({
  detail,
  onBack,
  onSubmitted,
}: {
  detail: StockCountDetail;
  onBack: () => void;
  onSubmitted: (d: StockCountDetail) => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const done = detail.status !== 'OPEN';

  // Local entry state, keyed by ingredient. Seeded from the count (for a
  // completed/resumed count these already carry values) and preserved across
  // every keystroke — there is no server request while editing.
  const [entries, setEntries] = useState<Record<string, Entry>>(() =>
    Object.fromEntries(
      detail.lines.map((l) => [
        l.ingredientId,
        {
          counted: l.countedQuantity === null ? '' : String(l.countedQuantity),
          reason: l.reason ?? '',
        },
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);

  const setEntry = (id: string, patch: Partial<Entry>) =>
    setEntries((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  // A stable idempotency-free submit is not needed — the backend replays a
  // completed count without writing again — but we still guard the button.
  const countedLines = detail.lines
    .map((l) => ({ line: l, counted: parseCounted(entries[l.ingredientId]?.counted ?? '') }))
    .filter((x): x is { line: StockCountLine; counted: number } => x.counted !== null);

  const needsReason = countedLines.filter(
    ({ line, counted }) =>
      counted - line.currentStock !== 0 && !entries[line.ingredientId]?.reason,
  );

  const canSubmit = countedLines.length > 0 && needsReason.length === 0;

  async function submit() {
    if (!accessToken || !canSubmit) return;
    setBusy(true);
    try {
      const updated = await submitStockCount(accessToken, onNewToken, detail.id, {
        lines: countedLines.map(({ line }) => ({
          ingredientId: line.ingredientId,
          countedQuantity: parseCounted(entries[line.ingredientId].counted)!,
          ...(entries[line.ingredientId].reason
            ? { reason: entries[line.ingredientId].reason as StockCountReason }
            : {}),
        })),
      });
      toast({ title: 'Count submitted', variant: 'success' });
      onSubmitted(updated);
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not submit the count',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!accessToken) return;
    setBusy(true);
    try {
      await cancelStockCount(accessToken, onNewToken, detail.id);
      toast({ title: 'Count cancelled', variant: 'success' });
      onBack();
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not cancel the count',
        variant: 'danger',
      });
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl pb-28">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden className="size-4" />
          Back
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-mono text-[15px] font-semibold">{detail.code}</h1>
        </div>
        <Badge variant={STATUS_META[detail.status].variant}>
          {STATUS_META[detail.status].label}
        </Badge>
      </div>

      {done ? (
        <p className="mt-3 rounded-lg bg-success/10 px-3 py-2 text-[13px] text-success-text">
          This count is {detail.status === 'COMPLETED' ? 'complete' : 'cancelled'} and can no
          longer be edited.
        </p>
      ) : (
        <p className="mt-3 text-[13px] text-ink-3">
          Enter what you physically counted for each item. Items you leave blank
          are treated as not counted.
        </p>
      )}

      <ul className="mt-4 space-y-3">
        {detail.lines.map((line) => (
          <CountLineCard
            key={line.id}
            line={line}
            entry={entries[line.ingredientId]}
            readOnly={done}
            onChange={(patch) => setEntry(line.ingredientId, patch)}
          />
        ))}
      </ul>

      {!done && (
        // Sticky submit bar — stays visible above the keyboard and while
        // scrolling the list, at every width.
        <div className="fixed inset-x-0 bottom-0 border-t border-line bg-surface/95 backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1 text-[12px] text-ink-3">
              {countedLines.length === 0
                ? 'Count at least one item to submit.'
                : needsReason.length > 0
                  ? `Add a reason for ${needsReason.length} changed ${needsReason.length === 1 ? 'item' : 'items'}.`
                  : `${countedLines.length} counted · ready to submit`}
            </div>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!canSubmit || busy} onClick={() => void submit()}>
              {busy ? 'Submitting…' : 'Submit count'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CountLineCard({
  line,
  entry,
  readOnly,
  onChange,
}: {
  line: StockCountLine;
  entry: Entry;
  readOnly: boolean;
  onChange: (patch: Partial<Entry>) => void;
}) {
  const counted = parseCounted(entry?.counted ?? '');
  // Difference is measured against LIVE stock (currentStock) — exactly what the
  // server will apply — not the start snapshot, so the preview never surprises.
  const diff = counted === null ? null : counted - line.currentStock;
  const invalid = (entry?.counted ?? '').trim() !== '' && counted === null;
  const needsReason = diff !== null && diff !== 0 && !entry?.reason && !readOnly;

  return (
    <li className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="min-w-0 truncate font-medium">{line.name}</h3>
        <span className="shrink-0 text-[12px] text-ink-3">
          System {formatQuantity(line.currentStock, line.unit)}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label={`Counted quantity (${unitLabel(line.unit)})`} error={invalid ? 'Whole number, 0 or more' : null}>
          <Input
            inputMode="numeric"
            className="h-11 text-lg"
            value={entry?.counted ?? ''}
            disabled={readOnly}
            error={invalid}
            onChange={(e) => onChange({ counted: e.target.value })}
            placeholder="—"
            aria-label={`Counted quantity for ${line.name} in ${unitLabel(line.unit)}`}
          />
        </Field>

        <div>
          <span className="text-label mb-1.5 block">Difference</span>
          <DifferenceReadout diff={diff} unit={line.unit} counted={counted} />
        </div>
      </div>

      {/* Reason appears (and is required) only when stock actually changed. */}
      {diff !== null && diff !== 0 && (
        <div className="mt-3">
          <Field label="Reason" error={needsReason ? 'A reason is required' : null}>
            <Select
              value={entry?.reason ?? ''}
              disabled={readOnly}
              error={needsReason}
              onChange={(e) => onChange({ reason: e.target.value as StockCountReason | '' })}
            >
              <option value="">Choose a reason…</option>
              {REASONS.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </li>
  );
}

/** The live difference, labelled in words — never colour alone. */
function DifferenceReadout({
  diff,
  unit,
  counted,
}: {
  diff: number | null;
  unit: StockCountLine['unit'];
  counted: number | null;
}) {
  if (diff === null) {
    return (
      <p className="flex h-11 items-center text-sm text-ink-3" aria-live="polite">
        Not counted
      </p>
    );
  }
  if (diff === 0) {
    return (
      <div className="flex h-11 items-center gap-2" aria-live="polite">
        <Badge variant="success">Matches</Badge>
        <span className="text-sm text-ink-2 tabular-nums">
          {formatQuantity(counted!, unit)}
        </span>
      </div>
    );
  }
  const short = diff < 0;
  return (
    <div className="flex h-11 items-center gap-2" aria-live="polite">
      <Badge variant={short ? 'danger' : 'info'}>{short ? 'Short' : 'Over'}</Badge>
      <span
        className={cn(
          'text-sm font-medium tabular-nums',
          short ? 'text-danger-text' : 'text-info-text',
        )}
      >
        {short ? '−' : '+'}
        {formatQuantity(Math.abs(diff), unit)}
      </span>
    </div>
  );
}
