'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardList, Plus, Star, Trash2, Truck } from 'lucide-react';
import {
  ApiRequestError,
  createPurchaseOrder,
  getPurchaseOrder,
  getReorderSuggestions,
  getSupplierInsights,
  listIngredients,
  listPurchaseOrders,
  listSuppliers,
  transitionPurchaseOrder,
  updateSupplier,
  type IngredientRow,
  type PurchaseOrder,
  type PurchaseOrderRow,
  type PurchaseOrderStatus,
  type ReorderSuggestion,
  type Supplier,
  type SupplierInsight,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatMinor } from '@/lib/money';
import { formatQuantity, unitLabel } from '@/lib/units';
import { timeShort } from '../orders/order-detail';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';

/**
 * Procurement — reorder intelligence, purchase orders and supplier insights.
 * Every figure is read from the existing stock ledger; a received PO writes
 * ordinary PURCHASE movements, so nothing about purchase history is stored twice.
 */

const STATUS_META: Record<
  PurchaseOrderStatus,
  { label: string; variant: 'neutral' | 'info' | 'success' | 'danger' }
> = {
  DRAFT: { label: 'Draft', variant: 'neutral' },
  ORDERED: { label: 'Ordered', variant: 'info' },
  RECEIVED: { label: 'Received', variant: 'success' },
  CANCELLED: { label: 'Cancelled', variant: 'danger' },
};

function poTotalMinor(items: Array<{ totalCostMinor: number | null }>): number {
  return items.reduce((s, i) => s + (i.totalCostMinor ?? 0), 0);
}

export function ProcurementClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();
  const err = (e: unknown, fallback: string) =>
    toast({
      title: e instanceof ApiRequestError ? e.message : fallback,
      variant: 'danger',
    });

  const [suggestions, setSuggestions] = useState<ReorderSuggestion[] | null>(null);
  const [orders, setOrders] = useState<PurchaseOrderRow[] | null>(null);
  const [insights, setInsights] = useState<SupplierInsight[] | null>(null);
  const [ingredients, setIngredients] = useState<IngredientRow[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const [busyOrder, setBusyOrder] = useState<string | null>(null);

  const tokenRef = useRef(accessToken);
  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    const run = async () => {
      try {
        const [sug, ords, ins, ings, sups] = [
          await getReorderSuggestions(accessToken, onNewToken),
          await listPurchaseOrders(accessToken, onNewToken),
          await getSupplierInsights(accessToken, onNewToken),
          await listIngredients(accessToken, onNewToken),
          await listSuppliers(accessToken, onNewToken),
        ];
        if (cancelled) return;
        setSuggestions(sug);
        setOrders(ords);
        setInsights(ins);
        setIngredients(ings);
        setSuppliers(sups);
      } catch (e) {
        if (!cancelled)
          toast({
            title:
              e instanceof ApiRequestError ? e.message : 'Could not load procurement',
            variant: 'danger',
          });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, reloadKey, toast]);

  // One-click reorder: draft a PO for the ingredient's last supplier.
  async function quickOrder(s: ReorderSuggestion) {
    if (!accessToken || !s.lastSupplier) return;
    setBusyOrder(s.ingredientId);
    try {
      await createPurchaseOrder(accessToken, onNewToken, {
        supplierId: s.lastSupplier.id,
        items: [{ ingredientId: s.ingredientId, quantity: s.suggestedQuantity }],
      });
      toast({ title: `Drafted an order for ${s.name}`, variant: 'success' });
      reload();
    } catch (e) {
      err(e, 'Could not draft the order');
    } finally {
      setBusyOrder(null);
    }
  }

  async function togglePreferred(s: SupplierInsight) {
    if (!accessToken) return;
    try {
      await updateSupplier(accessToken, onNewToken, s.id, { preferred: !s.preferred });
      reload();
    } catch (e) {
      err(e, 'Could not update the supplier');
    }
  }

  const loading = suggestions === null || orders === null || insights === null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Procurement</h1>
        <Button
          variant="primary"
          onClick={() => setAdding(true)}
          disabled={suppliers.length === 0 || ingredients.length === 0}
        >
          <Plus aria-hidden className="size-4" />
          New order
        </Button>
      </div>

      {loading ? (
        <div className="mt-6 space-y-4" role="status" aria-busy="true" aria-label="Loading procurement">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : (
        <div className="mt-6 space-y-8">
          {/* Reorder suggestions */}
          <section>
            <h2 className="text-sm font-semibold tracking-tight">Reorder suggestions</h2>
            <p className="mt-0.5 text-[12px] text-ink-3">
              Ingredients at or below their reorder level, with a suggested top-up.
            </p>
            <div className="mt-3 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
              {suggestions!.length === 0 ? (
                <EmptyState
                  icon={ClipboardList}
                  title="Nothing to reorder"
                  body="Every tracked ingredient is above its reorder level."
                />
              ) : (
                <ul className="divide-y divide-line">
                  {suggestions!.map((s) => (
                    <li key={s.ingredientId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{s.name}</p>
                        <p className="text-[12px] text-ink-3">
                          {formatQuantity(s.currentStock, s.unit)} in stock
                          {s.reorderLevel !== null &&
                            ` · reorder at ${formatQuantity(s.reorderLevel, s.unit)}`}
                          {s.lastSupplier && ` · last from ${s.lastSupplier.name}`}
                        </p>
                      </div>
                      <span className="text-[13px] font-medium tabular-nums">
                        order ~{formatQuantity(s.suggestedQuantity, s.unit)}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!s.lastSupplier || busyOrder === s.ingredientId}
                        onClick={() => void quickOrder(s)}
                        title={s.lastSupplier ? undefined : 'Receive stock from a supplier first'}
                      >
                        {busyOrder === s.ingredientId ? '…' : 'Draft order'}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* Purchase orders */}
          <section>
            <h2 className="text-sm font-semibold tracking-tight">Purchase orders</h2>
            <div className="mt-3 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
              {orders!.length === 0 ? (
                <EmptyState
                  icon={ClipboardList}
                  title="No purchase orders yet"
                  body="Draft one from a reorder suggestion, or with New order."
                />
              ) : (
                <ul className="divide-y divide-line">
                  {orders!.map((o) => {
                    const meta = STATUS_META[o.status];
                    const total = poTotalMinor(o.items);
                    return (
                      <li key={o.id}>
                        <button
                          type="button"
                          onClick={() => setOpenId(o.id)}
                          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                        >
                          <Badge variant={meta.variant}>{meta.label}</Badge>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {o.supplier.name}
                            </span>
                            <span className="block text-[12px] text-ink-3">
                              {o.items.length} item{o.items.length === 1 ? '' : 's'}
                              {total > 0 && ` · ${formatMinor(total)}`} · {timeShort(o.createdAt)}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          {/* Supplier insights */}
          <section>
            <h2 className="text-sm font-semibold tracking-tight">Suppliers</h2>
            <div className="mt-3 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
              {insights!.length === 0 ? (
                <EmptyState
                  icon={Truck}
                  title="No suppliers yet"
                  body="Add suppliers on the Inventory page, then buy stock to build their history."
                />
              ) : (
                <ul className="divide-y divide-line">
                  {insights!.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                      <button
                        type="button"
                        onClick={() => void togglePreferred(s)}
                        aria-pressed={s.preferred}
                        aria-label={s.preferred ? `Unmark ${s.name} as preferred` : `Mark ${s.name} as preferred`}
                        className="shrink-0 rounded p-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                      >
                        <Star
                          aria-hidden
                          className={cn(
                            'size-4',
                            s.preferred ? 'fill-warning text-warning-text' : 'text-ink-3',
                          )}
                        />
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{s.name}</p>
                        <p className="text-[12px] text-ink-3">
                          {s.purchaseCount === 0
                            ? 'No purchases yet'
                            : `${s.purchaseCount} purchase${s.purchaseCount === 1 ? '' : 's'}` +
                              (s.lastPurchaseAt ? ` · last ${timeShort(s.lastPurchaseAt)}` : '') +
                              (s.avgIntervalDays != null ? ` · ~${s.avgIntervalDays}d apart` : '') +
                              (s.topIngredient ? ` · mostly ${s.topIngredient.name}` : '')}
                        </p>
                      </div>
                      <span className="text-[13px] font-medium tabular-nums">
                        {s.totalSpentMinor > 0 ? formatMinor(s.totalSpentMinor) : '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}

      <NewOrderModal
        open={adding}
        onClose={() => setAdding(false)}
        suppliers={suppliers}
        ingredients={ingredients}
        onCreated={() => {
          setAdding(false);
          reload();
        }}
      />

      <PurchaseOrderSheet
        id={openId}
        onClose={() => setOpenId(null)}
        onChanged={reload}
      />
    </div>
  );
}

function NewOrderModal({
  open,
  onClose,
  suppliers,
  ingredients,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  suppliers: Supplier[];
  ingredients: IngredientRow[];
  onCreated: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [supplierId, setSupplierId] = useState('');
  const [lines, setLines] = useState<Array<{ ingredientId: string; qty: string }>>([
    { ingredientId: '', qty: '' },
  ]);
  const [busy, setBusy] = useState(false);

  const setLine = (i: number, patch: Partial<{ ingredientId: string; qty: string }>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const items = lines
    .map((l) => ({ ingredientId: l.ingredientId, quantity: Number(l.qty) }))
    .filter((l) => l.ingredientId && Number.isInteger(l.quantity) && l.quantity > 0);
  const dupes = new Set(items.map((i) => i.ingredientId)).size !== items.length;
  const valid = supplierId !== '' && items.length > 0 && !dupes;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !valid) return;
    setBusy(true);
    try {
      await createPurchaseOrder(accessToken, onNewToken, { supplierId, items });
      toast({ title: 'Purchase order drafted', variant: 'success' });
      setSupplierId('');
      setLines([{ ingredientId: '', qty: '' }]);
      onCreated();
    } catch (e2) {
      toast({
        title: e2 instanceof ApiRequestError ? e2.message : 'Could not create the order',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New purchase order">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Supplier">
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Choose a supplier…</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.preferred ? ' ★' : ''}
              </option>
            ))}
          </Select>
        </Field>

        <div className="space-y-2">
          <span className="text-label">Items</span>
          {lines.map((l, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="flex-1">
                <Select
                  aria-label="Ingredient"
                  value={l.ingredientId}
                  onChange={(e) => setLine(i, { ingredientId: e.target.value })}
                >
                  <option value="">Ingredient…</option>
                  {ingredients.map((ing) => (
                    <option key={ing.id} value={ing.id}>
                      {ing.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-28">
                <Input
                  aria-label="Quantity"
                  inputMode="numeric"
                  placeholder={
                    l.ingredientId
                      ? unitLabel(
                          ingredients.find((x) => x.id === l.ingredientId)?.unit ?? 'PIECE',
                        )
                      : 'qty'
                  }
                  value={l.qty}
                  onChange={(e) => setLine(i, { qty: e.target.value })}
                />
              </div>
              {lines.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Remove line"
                  onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                  className="mb-0.5 text-ink-3 hover:text-danger"
                >
                  <Trash2 aria-hidden className="size-4" />
                </Button>
              )}
            </div>
          ))}
          {dupes && (
            <p role="alert" className="text-[12px] text-danger-text">
              An ingredient appears twice — combine the quantities.
            </p>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setLines((ls) => [...ls, { ingredientId: '', qty: '' }])}
          >
            <Plus aria-hidden className="size-4" />
            Add item
          </Button>
        </div>

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!valid || busy}>
            {busy ? 'Creating…' : 'Create draft'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const NEXT_ACTIONS: Record<
  PurchaseOrderStatus,
  Array<{ to: 'ORDERED' | 'RECEIVED' | 'CANCELLED'; label: string; variant: 'primary' | 'secondary' | 'danger' }>
> = {
  DRAFT: [
    { to: 'ORDERED', label: 'Mark ordered', variant: 'primary' },
    { to: 'CANCELLED', label: 'Cancel', variant: 'danger' },
  ],
  ORDERED: [
    { to: 'RECEIVED', label: 'Receive stock', variant: 'primary' },
    { to: 'CANCELLED', label: 'Cancel', variant: 'danger' },
  ],
  RECEIVED: [],
  CANCELLED: [],
};

function PurchaseOrderSheet({
  id,
  onClose,
  onChanged,
}: {
  id: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset while rendering (not in an effect) when the selected order changes, so
  // reopening the sheet never flashes the previous order. React's sanctioned
  // "adjust state on a prop change" pattern; keeps the fetch effect side-effect-only.
  const [shownId, setShownId] = useState(id);
  if (id !== shownId) {
    setShownId(id);
    setPo(null);
  }

  useEffect(() => {
    if (!id || !accessToken) return;
    let cancelled = false;
    getPurchaseOrder(accessToken, onNewToken, id)
      .then((p) => {
        if (!cancelled) setPo(p);
      })
      .catch(() => {
        if (!cancelled) {
          toast({ title: 'Could not open the order', variant: 'danger' });
          onClose();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, accessToken, onNewToken, toast, onClose]);

  async function move(to: 'ORDERED' | 'RECEIVED' | 'CANCELLED') {
    if (!accessToken || !po) return;
    setBusy(true);
    try {
      const updated = await transitionPurchaseOrder(accessToken, onNewToken, po.id, to);
      setPo(updated);
      toast({
        title: to === 'RECEIVED' ? 'Stock received' : 'Order updated',
        variant: 'success',
      });
      onChanged();
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not update the order',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  const total = po ? poTotalMinor(po.items) : 0;

  return (
    <Sheet open={id !== null} onClose={onClose} title={po ? po.supplier.name : 'Purchase order'}>
      {!po ? (
        <div className="space-y-3" role="status" aria-busy="true" aria-label="Loading order">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-24" />
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_META[po.status].variant}>{STATUS_META[po.status].label}</Badge>
            <span className="text-[12px] text-ink-3">
              Drafted {timeShort(po.createdAt)}
              {po.receivedAt && ` · received ${timeShort(po.receivedAt)}`}
            </span>
          </div>

          <section>
            <h3 className="text-label mb-2">Items</h3>
            <ul className="space-y-1.5">
              {po.items.map((it) => (
                <li key={it.id} className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">{it.ingredient.name}</span>
                  <span className="tabular-nums text-ink-2">
                    {formatQuantity(it.quantity, it.ingredient.unit)}
                    {it.totalCostMinor !== null && ` · ${formatMinor(it.totalCostMinor)}`}
                  </span>
                </li>
              ))}
            </ul>
            {total > 0 && (
              <p className="mt-2 border-t border-line pt-2 text-right text-[13px] font-medium tabular-nums">
                Total {formatMinor(total)}
              </p>
            )}
          </section>

          {NEXT_ACTIONS[po.status].length > 0 ? (
            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              {NEXT_ACTIONS[po.status].map((a) => (
                <Button
                  key={a.to}
                  variant={a.variant}
                  disabled={busy}
                  onClick={() => void move(a.to)}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          ) : (
            <p className="border-t border-line pt-4 text-[12px] text-ink-3">
              {po.status === 'RECEIVED'
                ? 'Received — the stock was added to inventory.'
                : 'This order was cancelled.'}
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}
