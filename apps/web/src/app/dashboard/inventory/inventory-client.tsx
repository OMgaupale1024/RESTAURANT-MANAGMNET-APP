'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CookingPot, PackagePlus, Package } from 'lucide-react';
import {
  ApiRequestError,
  createIngredient,
  getIngredient,
  listIngredients,
  recordAdjustment,
  recordMovement,
  type IngredientDetail,
  type IngredientRow,
  type StockUnit,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatQuantity, unitLabel } from '@/lib/units';
import { timeShort } from '../orders/order-detail';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { RecipeEditor } from './recipe-editor';

/**
 * Inventory — the stock ledger surfaced for operations. Stock is
 * SUM(movements) server-side; negative numbers are shown honestly (the sale
 * was allowed to happen; the discrepancy is the owner's to resolve).
 */

const FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: 'LOW', label: 'Low stock' },
] as const;

/** Ledger rendering: label + colour per movement type, never colour alone. */
const MOVE_META: Record<string, { label: string; variant: 'success' | 'danger' | 'warning' | 'neutral' | 'info' }> = {
  PURCHASE: { label: 'Received', variant: 'success' },
  WASTE: { label: 'Waste', variant: 'danger' },
  CONSUMPTION: { label: 'Sold', variant: 'neutral' },
  ADJUSTMENT: { label: 'Count', variant: 'warning' },
};

function stockStatus(r: { currentStock: number; reorderLevel: number | null; isLow: boolean }) {
  if (r.currentStock < 0) return { label: 'Negative', variant: 'danger' as const };
  if (r.isLow) return { label: 'Low', variant: 'warning' as const };
  if (r.reorderLevel === null) return { label: 'Untracked', variant: 'neutral' as const };
  return { label: 'OK', variant: 'success' as const };
}

export function InventoryClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [rows, setRows] = useState<IngredientRow[] | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('ALL');
  const [adding, setAdding] = useState(false);
  const [recipesOpen, setRecipesOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<IngredientDetail | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const tokenRef = useRef(accessToken);
  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    listIngredients(accessToken, onNewToken)
      .then((list) => {
        if (!cancelled) setRows(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          toast({
            title: e instanceof ApiRequestError ? e.message : 'Could not load stock',
            variant: 'danger',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, reloadKey, toast]);

  const open = useCallback(
    (id: string) => {
      const token = tokenRef.current;
      if (!token) return;
      setSelectedId(id);
      setDetail(null);
      getIngredient(token, onNewToken, id)
        .then(setDetail)
        .catch((e: unknown) => {
          setSelectedId(null);
          toast({
            title: e instanceof ApiRequestError ? e.message : 'Could not open ingredient',
            variant: 'danger',
          });
        });
    },
    [onNewToken, toast],
  );

  const loading = rows === null;
  const all = rows ?? [];
  const list = filter === 'LOW' ? all.filter((r) => r.isLow) : all;
  const lowCount = all.filter((r) => r.isLow).length;
  const negativeCount = all.filter((r) => r.currentStock < 0).length;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Inventory</h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setRecipesOpen(true)}>
            <CookingPot aria-hidden className="size-4" />
            Recipes
          </Button>
          <Button variant="primary" onClick={() => setAdding(true)}>
            <PackagePlus aria-hidden className="size-4" />
            New ingredient
          </Button>
        </div>
      </div>

      {!loading && all.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-3">
          <StatCard label="Ingredients" value={all.length} format={String} />
          <StatCard label="Low stock" value={lowCount} format={String} />
          <StatCard label="Negative stock" value={negativeCount} format={String} />
        </div>
      )}

      <div className="mt-4">
        <Segmented options={FILTERS} value={filter} onChange={setFilter} className="max-w-fit" />
      </div>

      <div className="mt-4 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
        {loading ? (
          <div className="space-y-2 p-4" aria-label="Loading stock">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : list.length === 0 ? (
          filter === 'LOW' ? (
            <EmptyState
              icon={Package}
              title="Nothing is low"
              body="Every tracked ingredient is above its reorder level."
            />
          ) : (
            <EmptyState
              icon={Package}
              title="No ingredients yet"
              body="Add what you buy, give products a recipe, and every sale depletes stock automatically."
              action={
                <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
                  Add an ingredient
                </Button>
              }
            />
          )
        ) : (
          <Table containerClassName="max-h-[calc(100dvh-24rem)] overflow-y-auto rounded-xl">
            <thead>
              <tr>
                <Th>Ingredient</Th>
                <Th numeric>Current stock</Th>
                <Th>Status</Th>
                <Th numeric className="hidden md:table-cell">
                  Daily use (7d)
                </Th>
                <Th className="hidden sm:table-cell">Last movement</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const status = stockStatus(r);
                const daysLeft =
                  r.avgDailyUsage > 0 && r.currentStock > 0
                    ? Math.floor(r.currentStock / r.avgDailyUsage)
                    : null;
                return (
                  <Tr
                    key={r.id}
                    onClick={() => open(r.id)}
                    aria-selected={selectedId === r.id}
                    className={cn('animate-fade-up', selectedId === r.id && 'bg-surface-2')}
                  >
                    <Td>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          open(r.id);
                        }}
                        className="rounded font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                      >
                        {r.name}
                      </button>
                    </Td>
                    <Td numeric>
                      <span
                        className={cn(
                          'font-medium',
                          r.currentStock < 0 && 'text-danger-text',
                        )}
                      >
                        {formatQuantity(r.currentStock, r.unit)}
                      </span>
                      {/* Level vs reorder point, at a glance. Only for tracked
                          ingredients — a bar with no reference would be a lie. */}
                      {r.reorderLevel !== null && r.reorderLevel > 0 && (
                        <div
                          aria-hidden
                          className="mt-1 ml-auto h-1 w-24 overflow-hidden rounded-full bg-surface-2"
                        >
                          <div
                            className={cn(
                              'h-full rounded-full',
                              r.currentStock < 0
                                ? 'w-0'
                                : r.isLow
                                  ? 'bg-warning'
                                  : 'bg-success',
                            )}
                            style={{
                              width: `${Math.min(100, Math.max(0, (r.currentStock / (r.reorderLevel * 2)) * 100))}%`,
                            }}
                          />
                        </div>
                      )}
                    </Td>
                    <Td>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </Td>
                    <Td numeric className="hidden text-ink-2 md:table-cell">
                      {r.avgDailyUsage > 0 ? (
                        <>
                          {formatQuantity(r.avgDailyUsage, r.unit)}
                          {daysLeft !== null && (
                            <span className="ml-1.5 text-[11px] text-ink-3">
                              ~{daysLeft}d left
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </Td>
                    <Td className="hidden text-ink-2 sm:table-cell">
                      {r.lastMovementAt ? timeShort(r.lastMovementAt) : '—'}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>

      <Sheet
        open={selectedId !== null}
        onClose={() => {
          setSelectedId(null);
          setDetail(null);
        }}
        title={detail ? detail.name : 'Ingredient'}
      >
        {!detail ? (
          <div className="space-y-3" aria-label="Loading ingredient">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-24" />
            <Skeleton className="h-40" />
          </div>
        ) : (
          <IngredientSheet
            detail={detail}
            onChanged={() => {
              open(detail.id);
              reload();
            }}
          />
        )}
      </Sheet>

      <AddIngredientModal
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          reload();
        }}
      />

      <RecipeEditor
        open={recipesOpen}
        onClose={() => setRecipesOpen(false)}
        ingredients={all}
      />
    </div>
  );
}

const ACTIONS = [
  { key: 'PURCHASE', label: 'Receive' },
  { key: 'WASTE', label: 'Waste' },
  { key: 'ADJUSTMENT', label: 'Count' },
] as const;
type ActionKey = (typeof ACTIONS)[number]['key'];

function IngredientSheet({
  detail,
  onChanged,
}: {
  detail: IngredientDetail;
  onChanged: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [action, setAction] = useState<ActionKey>('PURCHASE');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const status = stockStatus(detail);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken) return;
    const n = Number(qty);
    // ADJUSTMENT is a signed correction; the others are positive magnitudes
    // whose sign the server derives from the type.
    const valid =
      Number.isInteger(n) && (action === 'ADJUSTMENT' ? n !== 0 : n > 0);
    if (!valid) {
      toast({
        title:
          action === 'ADJUSTMENT'
            ? 'Enter a non-zero whole number (negative to reduce)'
            : 'Enter a whole number greater than zero',
        variant: 'warning',
      });
      return;
    }
    setBusy(true);
    try {
      if (action === 'ADJUSTMENT') {
        await recordAdjustment(accessToken, onNewToken, detail.id, {
          quantity: n,
          ...(note.trim() ? { note: note.trim() } : {}),
        });
      } else {
        await recordMovement(accessToken, onNewToken, detail.id, {
          type: action,
          quantity: n,
          ...(note.trim() ? { note: note.trim() } : {}),
        });
      }
      toast({ title: 'Recorded', variant: 'success' });
      setQty('');
      setNote('');
      onChanged();
    } catch (e2) {
      toast({
        title: e2 instanceof ApiRequestError ? e2.message : 'Could not record',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p
          className={cn(
            'text-2xl font-semibold tracking-tight tabular-nums',
            detail.currentStock < 0 && 'text-danger-text',
          )}
        >
          {formatQuantity(detail.currentStock, detail.unit)}
        </p>
        <p className="mt-1 flex items-center gap-2 text-[12px] text-ink-3">
          <Badge variant={status.variant}>{status.label}</Badge>
          {detail.reorderLevel !== null &&
            `Low at ${formatQuantity(detail.reorderLevel, detail.unit)}`}
        </p>
        {detail.currentStock < 0 && (
          // Negative stock is not hidden: the sale was allowed to happen
          // and the discrepancy is the owner's to resolve.
          <p className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger-text">
            Sold more than was received — check the count and record a correction.
          </p>
        )}
      </div>

      <section>
        <h3 className="text-label mb-2">Record</h3>
        <form onSubmit={submit} className="space-y-3">
          <Segmented
            options={ACTIONS.map((a) => ({ key: a.key, label: a.label }))}
            value={action}
            onChange={setAction}
          />
          <div className="flex gap-2">
            <Field label={`Quantity (${unitLabel(detail.unit)})`}>
              <Input
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                placeholder={action === 'ADJUSTMENT' ? 'e.g. -250' : 'e.g. 500'}
              />
            </Field>
            <Field label="Note (optional)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
            </Field>
          </div>
          <Button variant="primary" type="submit" disabled={busy} className="w-full">
            {busy ? 'Recording…' : ACTIONS.find((a) => a.key === action)?.label}
          </Button>
        </form>
      </section>

      <section>
        <h3 className="text-label mb-2">Ledger</h3>
        {detail.movements.length === 0 ? (
          <p className="text-[13px] text-ink-3">No movements yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {detail.movements.map((m) => {
              const meta = MOVE_META[m.type] ?? { label: m.type, variant: 'neutral' as const };
              return (
                <li key={m.id} className="flex items-center gap-2.5 text-[13px]">
                  <Badge variant={meta.variant} className="w-20 justify-center">
                    {meta.label}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-ink-3">
                    {timeShort(m.createdAt)}
                    {m.note && ` · ${m.note}`}
                    {m.orderId && (
                      <>
                        {' · '}
                        <a
                          href={`/dashboard/orders?id=${m.orderId}`}
                          className="underline-offset-2 hover:underline"
                        >
                          view order
                        </a>
                      </>
                    )}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 font-medium tabular-nums',
                      m.quantity < 0 ? 'text-danger-text' : 'text-success-text',
                    )}
                  >
                    {m.quantity > 0 ? '+' : ''}
                    {formatQuantity(m.quantity, detail.unit)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function AddIngredientModal({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [name, setName] = useState('');
  const [unit, setUnit] = useState<StockUnit>('GRAM');
  const [reorder, setReorder] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !name.trim()) return;
    setBusy(true);
    try {
      const level = reorder.trim() ? Number(reorder) : undefined;
      await createIngredient(accessToken, onNewToken, {
        name: name.trim(),
        unit,
        ...(level !== undefined && Number.isInteger(level) && level >= 0
          ? { reorderLevel: level }
          : {}),
      });
      toast({ title: `${name.trim()} added`, variant: 'success' });
      setName('');
      setReorder('');
      onAdded();
    } catch (err) {
      toast({
        title: err instanceof ApiRequestError ? err.message : 'Could not add ingredient',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New ingredient">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Ingredient">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Unit">
            <Select value={unit} onChange={(e) => setUnit(e.target.value as StockUnit)}>
              <option value="GRAM">grams</option>
              <option value="MILLILITRE">millilitres</option>
              <option value="PIECE">pieces</option>
            </Select>
          </Field>
          <Field label="Low-stock level (optional)">
            <Input
              inputMode="numeric"
              value={reorder}
              onChange={(e) => setReorder(e.target.value)}
              placeholder="e.g. 1000"
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!name.trim() || busy}>
            {busy ? 'Adding…' : 'Add ingredient'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
