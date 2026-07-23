'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CookingPot, PackagePlus, Package, Truck } from 'lucide-react';
import {
  ApiRequestError,
  createIngredient,
  createSupplier,
  getIngredient,
  listIngredients,
  listSuppliers,
  recordAdjustment,
  recordMovement,
  updateIngredient,
  updateSupplier,
  type IngredientDetail,
  type IngredientRow,
  type StockUnit,
  type Supplier,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatMinor, parseRupeesToMinor } from '@/lib/money';
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
  { key: 'INACTIVE', label: 'Inactive' },
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

/**
 * Weighted-average cost per common unit. avgUnitCostMinor is paise per base
 * unit (gram/ml/piece); grams show per kg, millilitres per litre.
 */
function formatUnitCost(avgUnitCostMinor: number | null, unit: StockUnit): string | null {
  if (avgUnitCostMinor === null) return null;
  const per = unit === 'PIECE' ? 1 : 1000;
  const label = unit === 'GRAM' ? 'kg' : unit === 'MILLILITRE' ? 'L' : 'pc';
  return `${formatMinor(Math.round(avgUnitCostMinor * per))}/${label}`;
}

export function InventoryClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [rows, setRows] = useState<IngredientRow[] | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('ALL');
  const [adding, setAdding] = useState(false);
  const [recipesOpen, setRecipesOpen] = useState(false);
  const [suppliersOpen, setSuppliersOpen] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<IngredientDetail | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const reloadSuppliers = useCallback(() => {
    if (!accessToken) return;
    listSuppliers(accessToken, onNewToken)
      .then(setSuppliers)
      .catch(() => undefined);
  }, [accessToken, onNewToken]);

  useEffect(() => {
    reloadSuppliers();
  }, [reloadSuppliers]);

  const tokenRef = useRef(accessToken);
  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    listIngredients(accessToken, onNewToken, { all: true })
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
  // Operational tabs show active stock; Inactive is the management view.
  const active = all.filter((r) => r.isActive);
  const list =
    filter === 'INACTIVE'
      ? all.filter((r) => !r.isActive)
      : filter === 'LOW'
        ? active.filter((r) => r.isLow)
        : active;
  const lowCount = active.filter((r) => r.isLow).length;
  const negativeCount = active.filter((r) => r.currentStock < 0).length;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Inventory</h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setSuppliersOpen(true)}>
            <Truck aria-hidden className="size-4" />
            Suppliers
          </Button>
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
          <StatCard label="Ingredients" value={active.length} format={String} />
          <StatCard label="Low stock" value={lowCount} format={String} />
          <StatCard label="Negative stock" value={negativeCount} format={String} />
        </div>
      )}

      <div className="mt-4">
        <Segmented options={FILTERS} value={filter} onChange={setFilter} className="max-w-fit" />
      </div>

      <div className="mt-4 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
        {loading ? (
          <div className="space-y-2 p-4" role="status" aria-busy="true" aria-label="Loading stock">
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
          ) : filter === 'INACTIVE' ? (
            <EmptyState
              icon={Package}
              title="No deactivated ingredients"
              body="Deactivate an ingredient from its detail panel to retire it without losing its history."
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
                <Th numeric className="hidden lg:table-cell">
                  Cost
                </Th>
                <Th numeric className="hidden md:table-cell">
                  Daily use (7d)
                </Th>
                <Th className="hidden sm:table-cell">Last movement</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const status = r.isActive
                  ? stockStatus(r)
                  : { label: 'Inactive', variant: 'neutral' as const };
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
                    <Td numeric className="hidden text-ink-2 lg:table-cell">
                      {formatUnitCost(r.avgUnitCostMinor, r.unit) ?? (
                        <span className="text-ink-3">—</span>
                      )}
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
          <div className="space-y-3" role="status" aria-busy="true" aria-label="Loading ingredient">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-24" />
            <Skeleton className="h-40" />
          </div>
        ) : (
          <IngredientSheet
            detail={detail}
            suppliers={suppliers}
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

      <SuppliersSheet
        open={suppliersOpen}
        onClose={() => setSuppliersOpen(false)}
        suppliers={suppliers}
        onChanged={reloadSuppliers}
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
  suppliers,
  onChanged,
}: {
  detail: IngredientDetail;
  suppliers: Supplier[];
  onChanged: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [action, setAction] = useState<ActionKey>('PURCHASE');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [cost, setCost] = useState('');
  const [busy, setBusy] = useState(false);

  // A stable key per logical submit, so a double-click, network retry, or
  // refresh cannot apply the same movement twice — the server dedupes on it.
  // Regenerated when the inputs change (a new intent) and after a successful
  // record, mirroring the POS charge key.
  const idemKey = useRef<string>(crypto.randomUUID());
  const freshKey = () => {
    idemKey.current = crypto.randomUUID();
  };

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
          idempotencyKey: idemKey.current,
        });
      } else {
        // Cost + supplier ride along on a PURCHASE; the server ignores them
        // on a WASTE. Blank cost means "received, cost unknown".
        const costMinor = action === 'PURCHASE' ? parseRupeesToMinor(cost) : null;
        await recordMovement(accessToken, onNewToken, detail.id, {
          type: action,
          quantity: n,
          ...(action === 'PURCHASE' && supplierId ? { supplierId } : {}),
          ...(costMinor !== null ? { totalCostMinor: costMinor } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          idempotencyKey: idemKey.current,
        });
      }
      toast({ title: 'Recorded', variant: 'success' });
      setQty('');
      setNote('');
      setCost('');
      freshKey(); // the next record is a new intent
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
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
          <Badge variant={status.variant}>{status.label}</Badge>
          {detail.reorderLevel !== null &&
            `Low at ${formatQuantity(detail.reorderLevel, detail.unit)}`}
          {formatUnitCost(detail.avgUnitCostMinor, detail.unit) && (
            <span>· avg cost {formatUnitCost(detail.avgUnitCostMinor, detail.unit)}</span>
          )}
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
            onChange={(v) => {
              setAction(v);
              freshKey();
            }}
          />
          <div className="flex gap-2">
            <Field label={`Quantity (${unitLabel(detail.unit)})`}>
              <Input
                inputMode="numeric"
                value={qty}
                onChange={(e) => {
                  setQty(e.target.value);
                  freshKey();
                }}
                placeholder={action === 'ADJUSTMENT' ? 'e.g. -250' : 'e.g. 500'}
              />
            </Field>
            <Field label="Note (optional)">
              <Input
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  freshKey();
                }}
                maxLength={200}
              />
            </Field>
          </div>
          {/* Cost + supplier only make sense for a purchase. */}
          {action === 'PURCHASE' && (
            <div className="flex gap-2">
              <Field label="Total cost (₹, optional)">
                <Input
                  inputMode="decimal"
                  value={cost}
                  onChange={(e) => {
                    setCost(e.target.value);
                    freshKey();
                  }}
                  placeholder="e.g. 200.00"
                />
              </Field>
              <Field label="Supplier (optional)">
                <Select
                  value={supplierId}
                  onChange={(e) => {
                    setSupplierId(e.target.value);
                    freshKey();
                  }}
                >
                  <option value="">—</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          <Button variant="primary" type="submit" disabled={busy} className="w-full">
            {busy ? 'Recording…' : ACTIONS.find((a) => a.key === action)?.label}
          </Button>
        </form>
      </section>

      <EditDetails detail={detail} onChanged={onChanged} />

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
                    {m.totalCostMinor !== null && ` · ${formatMinor(m.totalCostMinor)}`}
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

/**
 * Name / unit / reorder-level editing plus deactivation. Unit is locked once
 * the ledger has entries — the server enforces it (movements OR recipes); the
 * disabled control just says so up front for the common case.
 */
function EditDetails({
  detail,
  onChanged,
}: {
  detail: IngredientDetail;
  onChanged: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [name, setName] = useState(detail.name);
  const [unit, setUnit] = useState<StockUnit>(detail.unit);
  const [reorder, setReorder] = useState(
    detail.reorderLevel === null ? '' : String(detail.reorderLevel),
  );
  const [busy, setBusy] = useState(false);

  const unitLocked = detail.movements.length > 0;
  const reorderTrim = reorder.trim();
  const reorderValid =
    reorderTrim === '' ||
    (Number.isInteger(Number(reorderTrim)) && Number(reorderTrim) >= 0);
  const valid = name.trim().length > 0 && reorderValid;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !valid) return;
    setBusy(true);
    try {
      await updateIngredient(accessToken, onNewToken, detail.id, {
        name: name.trim(),
        ...(unit !== detail.unit ? { unit } : {}),
        // Blank stops tracking (null); a number sets the level.
        reorderLevel: reorderTrim === '' ? null : Number(reorderTrim),
      });
      toast({ title: 'Ingredient updated', variant: 'success' });
      onChanged();
    } catch (e2) {
      toast({
        title: e2 instanceof ApiRequestError ? e2.message : 'Could not save',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    if (!accessToken) return;
    setBusy(true);
    try {
      await updateIngredient(accessToken, onNewToken, detail.id, {
        isActive: !detail.isActive,
      });
      toast({
        title: detail.isActive ? 'Ingredient deactivated' : 'Ingredient reactivated',
        variant: 'success',
      });
      onChanged();
    } catch (e2) {
      toast({
        title: e2 instanceof ApiRequestError ? e2.message : 'Could not update',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3 className="text-label mb-2">Details</h3>
      <form onSubmit={save} className="space-y-3">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Unit">
            <Select
              value={unit}
              disabled={unitLocked}
              onChange={(e) => setUnit(e.target.value as StockUnit)}
            >
              <option value="GRAM">grams</option>
              <option value="MILLILITRE">millilitres</option>
              <option value="PIECE">pieces</option>
            </Select>
          </Field>
          <Field label="Low-stock level">
            <Input
              inputMode="numeric"
              value={reorder}
              onChange={(e) => setReorder(e.target.value)}
              placeholder="blank = untracked"
            />
          </Field>
        </div>
        {unitLocked && (
          <p className="text-[12px] text-ink-3">
            The unit is fixed once movements exist — the ledger is recorded in it.
          </p>
        )}
        <Button
          variant="secondary"
          type="submit"
          disabled={!valid || busy}
          className="w-full"
        >
          {busy ? 'Saving…' : 'Save details'}
        </Button>
      </form>

      <div className="mt-4 border-t border-line pt-4">
        <p className="mb-2 text-[12px] text-ink-3">
          {detail.isActive
            ? 'Deactivating hides it from the stock list. Its ledger and history stay.'
            : 'This ingredient is deactivated. Reactivate to see it in the stock list again.'}
        </p>
        <Button
          type="button"
          variant={detail.isActive ? 'danger' : 'secondary'}
          disabled={busy}
          onClick={() => void toggleActive()}
          className="w-full"
        >
          {detail.isActive ? 'Deactivate ingredient' : 'Reactivate ingredient'}
        </Button>
      </div>
    </section>
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

/** Supplier list with inline add, rename, phone and deactivate. */
function SuppliersSheet({
  open,
  onClose,
  suppliers,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  suppliers: Supplier[];
  onChanged: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  const err = (e: unknown, fallback: string) =>
    toast({
      title: e instanceof ApiRequestError ? e.message : fallback,
      variant: 'danger',
    });

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !name.trim()) return;
    setBusy(true);
    try {
      await createSupplier(accessToken, onNewToken, {
        name: name.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      });
      setName('');
      setPhone('');
      onChanged();
    } catch (e2) {
      err(e2, 'Could not add the supplier');
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(s: Supplier) {
    if (!accessToken) return;
    setBusy(true);
    try {
      await updateSupplier(accessToken, onNewToken, s.id, { isActive: false });
      toast({ title: `${s.name} deactivated`, variant: 'success' });
      onChanged();
    } catch (e2) {
      err(e2, 'Could not update the supplier');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Suppliers">
      <div className="space-y-5">
        <p className="text-[12px] text-ink-3">
          Who you buy stock from. Pick one when receiving a delivery to build a
          purchase history and a per-ingredient cost.
        </p>

        {suppliers.length === 0 ? (
          <EmptyState
            icon={Truck}
            title="No suppliers yet"
            body="Add one below, then choose it on the Receive form."
          />
        ) : (
          <ul className="space-y-2">
            {suppliers.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{s.name}</p>
                  {s.phone && (
                    <p className="truncate font-mono text-[12px] text-ink-3">{s.phone}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void deactivate(s)}
                  className="shrink-0 text-ink-3 hover:text-danger"
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={add} className="space-y-3 border-t border-line pt-4">
          <Field label="Supplier name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="e.g. FreshFarm Dairy"
            />
          </Field>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label="Phone (optional)">
                <Input
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  maxLength={40}
                />
              </Field>
            </div>
            <Button type="submit" variant="secondary" disabled={!name.trim() || busy}>
              Add
            </Button>
          </div>
        </form>
      </div>
    </Sheet>
  );
}
