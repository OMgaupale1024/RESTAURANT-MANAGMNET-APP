'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Lock } from 'lucide-react';
import {
  ApiRequestError,
  closeSession,
  getCurrentSession,
  listSessions,
  openSession,
  recordCashMovement,
  type CashSession,
  type CashSessionRow,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatMinor, parseRupeesToMinor } from '@/lib/money';
import { PAYMENT_LABEL, timeFull, timeShort } from '../orders/order-detail';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';

/**
 * Day Close — the cash drawer. Open with a float, record non-sale cash in/out
 * through the shift, count down and close. Every figure in the settlement is
 * derived from real payments and refunds in the session window; the drawer is
 * never a running counter that could drift.
 */
export function CashClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [session, setSession] = useState<CashSession | null>(null);
  const [history, setHistory] = useState<CashSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    Promise.all([
      getCurrentSession(accessToken, onNewToken),
      listSessions(accessToken, onNewToken),
    ])
      .then(([cur, hist]) => {
        if (cancelled) return;
        setSession(cur);
        setHistory(hist);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setLoading(false);
          toast({
            title: e instanceof ApiRequestError ? e.message : 'Could not load the till',
            variant: 'danger',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, reloadKey, toast]);

  if (loading) {
    return (
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Day Close</h1>
        <div
          className="mt-6 max-w-2xl space-y-4"
          role="status"
          aria-busy="true"
          aria-label="Loading day close"
        >
          <Skeleton className="h-40" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Day Close</h1>

      <div className="mt-6 max-w-2xl space-y-4">
        {session ? (
          <OpenSession
            session={session}
            onChanged={(s) => setSession(s)}
            onClosed={() => {
              setSession(null);
              reload();
            }}
          />
        ) : (
          <OpenTill onOpened={(s) => setSession(s)} />
        )}

        {history.length > 0 && <History rows={history} />}
      </div>
    </div>
  );
}

function OpenTill({ onOpened }: { onOpened: (s: CashSession) => void }) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [float, setFloat] = useState('');
  const [busy, setBusy] = useState(false);
  const floatMinor = float.trim() === '' ? 0 : parseRupeesToMinor(float);
  const valid = floatMinor !== null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || floatMinor === null || busy) return;
    setBusy(true);
    try {
      const s = await openSession(accessToken, onNewToken, {
        openingFloatMinor: floatMinor,
      });
      toast({ title: 'Till opened', variant: 'success' });
      onOpened(s);
    } catch (err) {
      toast({
        title: err instanceof ApiRequestError ? err.message : 'Could not open the till',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Open the till" />
      <p className="mb-4 text-[13px] text-ink-3">
        Start the day by counting the cash already in the drawer — the opening
        float.
      </p>
      <form onSubmit={submit} className="flex items-end gap-3">
        <div className="flex-1">
          <Field label="Opening float (₹)">
            <Input
              inputMode="decimal"
              value={float}
              onChange={(e) => setFloat(e.target.value)}
              placeholder="e.g. 2000.00"
            />
          </Field>
        </div>
        <Button variant="primary" type="submit" disabled={!valid || busy}>
          {busy ? 'Opening…' : 'Open till'}
        </Button>
      </form>
    </Card>
  );
}

function OpenSession({
  session,
  onChanged,
  onClosed,
}: {
  session: CashSession;
  onChanged: (s: CashSession) => void;
  onClosed: () => void;
}) {
  const [moveOpen, setMoveOpen] = useState<'PAY_IN' | 'PAY_OUT' | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const r = session.report;

  return (
    <>
      <Card>
        <CardHeader
          title="Till is open"
          action={
            <span className="text-[12px] text-ink-3">
              Opened {timeShort(session.openedAt)}
            </span>
          }
        />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-sm sm:grid-cols-3">
          <Stat label="Opening float" value={formatMinor(r.openingFloatMinor)} />
          <Stat label="Cash sales" value={formatMinor(r.cashSalesMinor)} />
          <Stat label="Cash refunds" value={`−${formatMinor(r.cashRefundsMinor)}`} />
          <Stat label="Paid in" value={formatMinor(r.payInMinor)} />
          <Stat label="Paid out" value={`−${formatMinor(r.payOutMinor)}`} />
          <Stat
            label="Expected in drawer"
            value={formatMinor(r.expectedCashMinor)}
            strong
          />
        </dl>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setMoveOpen('PAY_IN')}>
            <ArrowDownToLine aria-hidden className="size-3.5" />
            Cash in
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setMoveOpen('PAY_OUT')}>
            <ArrowUpFromLine aria-hidden className="size-3.5" />
            Cash out
          </Button>
          <Button variant="primary" size="sm" onClick={() => setCloseOpen(true)}>
            <Lock aria-hidden className="size-3.5" />
            Close till
          </Button>
        </div>
      </Card>

      <Settlement report={r} />

      {session.movements.length > 0 && (
        <Card>
          <CardHeader title="Cash in / out" />
          <ul className="space-y-1.5">
            {session.movements.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 text-[13px]">
                <span className="flex items-center gap-2">
                  <Badge variant={m.type === 'PAY_IN' ? 'success' : 'warning'}>
                    {m.type === 'PAY_IN' ? 'In' : 'Out'}
                  </Badge>
                  <span className="text-ink-2">{m.reason}</span>
                </span>
                <span className="tabular-nums">
                  {m.type === 'PAY_IN' ? '' : '−'}
                  {formatMinor(m.amountMinor)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <MovementModal
        kind={moveOpen}
        sessionId={session.id}
        onClose={() => setMoveOpen(null)}
        onDone={onChanged}
      />
      <CloseModal
        open={closeOpen}
        session={session}
        onClose={() => setCloseOpen(false)}
        onClosed={onClosed}
      />
    </>
  );
}

function Settlement({ report }: { report: CashSession['report'] }) {
  const rows = report.payByMethod.filter((p) => p.count > 0 || p.amountMinor !== 0);
  return (
    <Card className="p-2">
      <div className="px-3 pt-3">
        <CardHeader title="Settlement by payment method" />
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Method</Th>
            <Th numeric>Orders</Th>
            <Th numeric>Taken</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <Tr>
              <Td className="text-ink-3">No sales yet</Td>
              <Td numeric>—</Td>
              <Td numeric>—</Td>
            </Tr>
          ) : (
            rows.map((p) => (
              <Tr key={p.method}>
                <Td>{PAYMENT_LABEL[p.method] ?? p.method}</Td>
                <Td numeric>{p.count}</Td>
                <Td numeric>{formatMinor(p.amountMinor)}</Td>
              </Tr>
            ))
          )}
          <Tr>
            <Td className="font-semibold">Gross sales</Td>
            <Td numeric />
            <Td numeric className="font-semibold">
              {formatMinor(report.grossSalesMinor)}
            </Td>
          </Tr>
          {report.refundsMinor > 0 && (
            <>
              <Tr>
                <Td className="text-danger-text">Refunds</Td>
                <Td numeric />
                <Td numeric className="text-danger-text">
                  −{formatMinor(report.refundsMinor)}
                </Td>
              </Tr>
              <Tr>
                <Td className="font-semibold">Net sales</Td>
                <Td numeric />
                <Td numeric className="font-semibold">
                  {formatMinor(report.netSalesMinor)}
                </Td>
              </Tr>
            </>
          )}
        </tbody>
      </Table>
    </Card>
  );
}

function MovementModal({
  kind,
  sessionId,
  onClose,
  onDone,
}: {
  kind: 'PAY_IN' | 'PAY_OUT' | null;
  sessionId: string;
  onClose: () => void;
  onDone: (s: CashSession) => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const amountMinor = parseRupeesToMinor(amount);
  const valid = amountMinor !== null && amountMinor >= 1 && reason.trim().length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !valid || !kind || busy) return;
    setBusy(true);
    try {
      const s = await recordCashMovement(accessToken, onNewToken, sessionId, {
        type: kind,
        amountMinor: amountMinor!,
        reason: reason.trim(),
      });
      toast({ title: 'Recorded', variant: 'success' });
      setAmount('');
      setReason('');
      onDone(s);
      onClose();
    } catch (err) {
      toast({
        title: err instanceof ApiRequestError ? err.message : 'Could not record',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={kind !== null}
      onClose={onClose}
      title={kind === 'PAY_OUT' ? 'Cash out (paid from till)' : 'Cash in (added to till)'}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Amount (₹)">
          <Input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Reason">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            placeholder={
              kind === 'PAY_OUT' ? 'e.g. paid vegetable supplier' : 'e.g. change top-up'
            }
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!valid || busy}>
            {busy ? 'Saving…' : 'Record'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CloseModal({
  open,
  session,
  onClose,
  onClosed,
}: {
  open: boolean;
  session: CashSession;
  onClose: () => void;
  onClosed: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [counted, setCounted] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<CashSession | null>(null);

  const countedMinor = parseRupeesToMinor(counted);
  const expected = session.report.expectedCashMinor;
  const variance = countedMinor !== null ? countedMinor - expected : null;

  async function doClose() {
    if (!accessToken || countedMinor === null || busy) return;
    setBusy(true);
    try {
      const s = await closeSession(accessToken, onNewToken, session.id, {
        closingCountedMinor: countedMinor,
      });
      setResult(s);
      toast({ title: 'Till closed', variant: 'success' });
    } catch (err) {
      toast({
        title: err instanceof ApiRequestError ? err.message : 'Could not close the till',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }

  // After a successful close, show the Z-report summary and let the user finish.
  if (result) {
    const v = result.varianceMinor ?? 0;
    return (
      <Modal open={open} onClose={onClosed} title={`Z-report — closed ${timeShort(result.closedAt ?? '')}`}>
        <dl className="space-y-2 text-sm">
          <Stat label="Opening float" value={formatMinor(result.openingFloatMinor)} />
          <Stat label="Cash sales" value={formatMinor(result.report.cashSalesMinor)} />
          <Stat label="Expected in drawer" value={formatMinor(result.expectedCashMinor ?? 0)} />
          <Stat label="Counted" value={formatMinor(result.closingCountedMinor ?? 0)} strong />
          <div className="flex items-baseline justify-between border-t border-line pt-2">
            <dt className="font-semibold">Variance</dt>
            <dd
              className={cn(
                'tabular-nums font-semibold',
                v < 0 ? 'text-danger-text' : v > 0 ? 'text-warning-text' : 'text-success-text',
              )}
            >
              {v === 0 ? 'Balanced' : `${v > 0 ? 'Over ' : 'Short '}${formatMinor(Math.abs(v))}`}
            </dd>
          </div>
        </dl>
        <div className="mt-4 flex justify-end">
          <Button variant="primary" onClick={onClosed}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <>
      <Modal open={open} onClose={onClose} title="Close the till">
        <p className="mb-4 text-[13px] text-ink-3">
          Count the cash in the drawer and enter the total. We compare it to the
          expected amount and record any difference.
        </p>
        <dl className="mb-4 space-y-2 text-sm">
          <Stat label="Expected in drawer" value={formatMinor(expected)} strong />
        </dl>
        <Field label="Counted cash (₹)">
          <Input
            inputMode="decimal"
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
            autoFocus
            placeholder="0.00"
          />
        </Field>
        {variance !== null && (
          <p className="mt-2 text-[13px]" aria-live="polite">
            {variance === 0 ? (
              <span className="text-success-text">Balanced.</span>
            ) : variance < 0 ? (
              <span className="text-danger-text">
                Short {formatMinor(-variance)}
              </span>
            ) : (
              <span className="text-warning-text">Over {formatMinor(variance)}</span>
            )}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={countedMinor === null || busy}
            onClick={() => setConfirm(true)}
          >
            Close till
          </Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => void doClose()}
        title="Close the till?"
        body="This ends the current session and locks its report. A new session starts fresh."
        confirmLabel="Close till"
      />
    </>
  );
}

function History({ rows }: { rows: CashSessionRow[] }) {
  return (
    <Card className="p-2">
      <div className="px-3 pt-3">
        <CardHeader title="Recent sessions" />
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Opened</Th>
            <Th>Closed</Th>
            <Th numeric>Float</Th>
            <Th numeric>Counted</Th>
            <Th numeric>Variance</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const v = s.varianceMinor;
            return (
              <Tr key={s.id}>
                <Td className="tabular-nums" title={timeFull(s.openedAt)}>
                  {timeShort(s.openedAt)}
                </Td>
                <Td className="tabular-nums">
                  {s.closedAt ? (
                    timeShort(s.closedAt)
                  ) : (
                    <Badge variant="success">Open</Badge>
                  )}
                </Td>
                <Td numeric>{formatMinor(s.openingFloatMinor)}</Td>
                <Td numeric>
                  {s.closingCountedMinor === null
                    ? '—'
                    : formatMinor(s.closingCountedMinor)}
                </Td>
                <Td numeric>
                  {v === null ? (
                    '—'
                  ) : (
                    <span
                      className={cn(
                        'tabular-nums',
                        v < 0 ? 'text-danger-text' : v > 0 ? 'text-warning-text' : 'text-ink-2',
                      )}
                    >
                      {v === 0 ? 'Balanced' : `${v > 0 ? '+' : '−'}${formatMinor(Math.abs(v))}`}
                    </span>
                  )}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-2">{label}</dt>
      <dd className={cn('tabular-nums', strong && 'font-semibold')}>{value}</dd>
    </div>
  );
}
