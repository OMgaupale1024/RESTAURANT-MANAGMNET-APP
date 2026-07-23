'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { ApiRequestError, getAuditLog, type AuditEntry } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatMinor } from '@/lib/money';
import { timeFull } from '../orders/order-detail';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';

/**
 * The tenant audit log — the owner's record of who did what, especially the
 * money-reversing actions (voids, refunds). Read-only and append-only at the
 * source; this screen just surfaces it. audit.read only (owner/manager).
 */

const PAGE = 50;

const ACTION_LABEL: Record<string, string> = {
  'restaurant.created': 'Restaurant created',
  'restaurant.updated': 'Business profile edited',
  'order.voided': 'Order voided',
  'order.refunded': 'Refund recorded',
};

function describe(e: AuditEntry): string {
  const m = e.metadata ?? {};
  const orderNo = typeof m.orderNumber === 'number' ? ` #${m.orderNumber}` : '';
  const amount = typeof m.amountMinor === 'number' ? ` ${formatMinor(m.amountMinor)}` : '';
  const reason = typeof m.reason === 'string' && m.reason ? ` — “${m.reason}”` : '';
  const label = ACTION_LABEL[e.action] ?? e.action;
  return `${label}${orderNo}${amount}${reason}`;
}

const ACTION_VARIANT: Record<string, 'danger' | 'warning' | 'info' | 'neutral'> = {
  'order.voided': 'danger',
  'order.refunded': 'warning',
  'restaurant.updated': 'info',
};

export function AuditClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const tokenRef = useRef(accessToken);
  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    getAuditLog(accessToken, onNewToken, { limit: PAGE })
      .then((page) => {
        if (cancelled) return;
        setRows(page);
        setHasMore(page.length === PAGE);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          toast({
            title: e instanceof ApiRequestError ? e.message : 'Could not load the audit log',
            variant: 'danger',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, toast]);

  const loadMore = useCallback(async () => {
    const token = tokenRef.current;
    if (!token || loadingMore || !rows?.length) return;
    setLoadingMore(true);
    try {
      const page = await getAuditLog(token, onNewToken, {
        cursor: rows[rows.length - 1].id,
        limit: PAGE,
      });
      setRows((prev) => {
        const seen = new Set((prev ?? []).map((r) => r.id));
        return [...(prev ?? []), ...page.filter((r) => !seen.has(r.id))];
      });
      setHasMore(page.length === PAGE);
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not load more',
        variant: 'danger',
      });
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, rows, onNewToken, toast]);

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Audit Log</h1>
      <p className="mt-1 text-[13px] text-ink-3">
        Every money-reversing and settings change, oldest actions preserved.
        This record cannot be edited or deleted.
      </p>

      <div className="mt-4 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
        {rows === null ? (
          <div className="space-y-2 p-4" role="status" aria-busy="true" aria-label="Loading audit log">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="Nothing logged yet"
            body="Voids, refunds and profile edits will appear here as they happen."
          />
        ) : (
          <Table containerClassName="max-h-[calc(100dvh-14rem)] overflow-y-auto rounded-xl">
            <thead>
              <tr>
                <Th>Action</Th>
                <Th className="hidden sm:table-cell">When</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <Tr key={e.id}>
                  <Td>
                    <span className="flex items-center gap-2">
                      <Badge variant={ACTION_VARIANT[e.action] ?? 'neutral'}>
                        {e.entityType}
                      </Badge>
                      <span>{describe(e)}</span>
                    </span>
                  </Td>
                  <Td className="hidden text-ink-2 tabular-nums sm:table-cell" title={timeFull(e.createdAt)}>
                    {timeFull(e.createdAt)}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      {rows !== null && rows.length > 0 && (
        <div className="mt-2 flex items-center gap-3">
          <p className="text-[12px] text-ink-3 tabular-nums">
            {rows.length} entr{rows.length === 1 ? 'y' : 'ies'}
            {hasMore && ' · older entries available'}
          </p>
          {hasMore && (
            <Button variant="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? 'Loading…' : 'Load older'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
