'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  ChefHat,
  Clock,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  ApiRequestError,
  createPrepBatch,
  createPrepItem,
  getPrepItem,
  listIngredients,
  listPrepItems,
  setPrepRecipe,
  wastePrepBatch,
  type IngredientRow,
  type PrepItemDetail,
  type PrepItemRow,
  type StockUnit,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatMinor } from '@/lib/money';
import { formatQuantity, unitLabel } from '@/lib/units';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';

/**
 * Prep — prepared stock the kitchen makes from raw ingredients, in batches.
 * Mobile-first: this is a phone/tablet screen at the counter. Everything is one
 * column of cards with big actions; the maths (scaling, cost, FEFO) is the
 * server's, so this screen only shows and collects.
 */
export function PrepClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();
  const router = useRouter();

  const [items, setItems] = useState<PrepItemRow[] | null>(null);
  const [ingredients, setIngredients] = useState<IngredientRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [prepareId, setPrepareId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    Promise.all([
      listPrepItems(accessToken, onNewToken),
      listIngredients(accessToken, onNewToken),
    ])
      .then(([p, ing]) => {
        if (cancelled) return;
        setItems(p);
        setIngredients(ing);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          toast({
            title: e instanceof ApiRequestError ? e.message : 'Could not load prep',
            variant: 'danger',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, reloadKey, toast]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Back to inventory"
            onClick={() => router.push('/dashboard/inventory')}
            className="w-8 px-0"
          >
            <ArrowLeft aria-hidden className="size-4" />
          </Button>
          <h1 className="text-xl font-semibold tracking-tight">Prep</h1>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus aria-hidden className="size-4" />
          New prep item
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items === null ? (
          <>
            <Skeleton className="h-36" />
            <Skeleton className="h-36" />
            <Skeleton className="h-36" />
          </>
        ) : items.length === 0 ? (
          <div className="sm:col-span-2 lg:col-span-3">
            <EmptyState
              icon={ChefHat}
              title="No prep items yet"
              body="Add something the kitchen makes — a filling, a dough, a chutney — then give it a recipe and prepare a batch."
            />
          </div>
        ) : (
          items.map((it) => (
            <PrepCard
              key={it.id}
              item={it}
              onPrepare={() => setPrepareId(it.id)}
              onOpen={() => setDetailId(it.id)}
            />
          ))
        )}
      </div>

      <NewPrepItemModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          reload();
          setDetailId(id); // straight into the new item to set its recipe
        }}
      />

      <PrepareBatchSheet
        itemId={prepareId}
        onClose={() => setPrepareId(null)}
        onDone={() => {
          setPrepareId(null);
          reload();
        }}
      />

      <DetailSheet
        itemId={detailId}
        ingredients={ingredients}
        onClose={() => setDetailId(null)}
        onChanged={reload}
        onPrepare={(id) => {
          setDetailId(null);
          setPrepareId(id);
        }}
      />
    </div>
  );
}

function PrepCard({
  item,
  onPrepare,
  onOpen,
}: {
  item: PrepItemRow;
  onPrepare: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-line p-3">
      <button
        type="button"
        onClick={onOpen}
        className="flex-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
      >
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-[15px] font-semibold">{item.name}</p>
          <span className="shrink-0 text-[15px] font-semibold tabular-nums">
            {formatQuantity(item.available, item.unit)}
          </span>
        </div>
        <p className="mt-0.5 text-[12px] text-ink-3">available</p>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {!item.hasRecipe && <Badge variant="neutral">No recipe</Badge>}
          {item.expired > 0 && (
            <Badge variant="danger">
              {item.expired} expired
            </Badge>
          )}
          {item.expiringSoon > 0 && (
            <Badge variant="warning">{item.expiringSoon} expiring</Badge>
          )}
          {item.isLow && <Badge variant="warning">Low</Badge>}
        </div>

        <div className="mt-2 flex gap-4 text-[12px] text-ink-2">
          <span>
            Prepared today{' '}
            <span className="font-medium tabular-nums">
              {formatQuantity(item.preparedToday, item.unit)}
            </span>
          </span>
          {item.wasteToday > 0 && (
            <span className="text-danger-text">
              Waste {formatQuantity(item.wasteToday, item.unit)}
            </span>
          )}
        </div>
      </button>

      <Button
        variant="primary"
        onClick={onPrepare}
        disabled={!item.hasRecipe}
        className="mt-3 w-full"
      >
        <ChefHat aria-hidden className="size-4" />
        Prepare batch
      </Button>
    </div>
  );
}

const UNITS: Array<{ value: StockUnit; label: string }> = [
  { value: 'GRAM', label: 'Grams (kg / g)' },
  { value: 'MILLILITRE', label: 'Millilitres (l / ml)' },
  { value: 'PIECE', label: 'Pieces' },
];

function NewPrepItemModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<StockUnit>('GRAM');
  const [shelfLife, setShelfLife] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset on every close (cancel or after create) so the next open is fresh —
  // no reset-in-effect, which cascades renders.
  function reset() {
    setName('');
    setUnit('GRAM');
    setShelfLife('');
  }
  function close() {
    reset();
    onClose();
  }

  async function save() {
    if (!accessToken || !name.trim() || busy) return;
    setBusy(true);
    try {
      const hours = shelfLife.trim() ? Math.round(Number(shelfLife) * 24) : undefined;
      const created = await createPrepItem(accessToken, onNewToken, {
        name: name.trim(),
        unit,
        ...(hours && Number.isFinite(hours) ? { shelfLifeHours: hours } : {}),
      });
      toast({ title: `${created.name} added`, variant: 'success' });
      reset();
      onCreated(created.id);
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not create the item',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title="New prep item">
      <div className="space-y-4">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Veg Filling"
            autoFocus
          />
        </Field>
        <Field label="Unit">
          <Select value={unit} onChange={(e) => setUnit(e.target.value as StockUnit)}>
            {UNITS.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Shelf life (days, optional)">
          <Input
            inputMode="decimal"
            value={shelfLife}
            onChange={(e) => setShelfLife(e.target.value)}
            placeholder="1"
          />
        </Field>
        <p className="text-[12px] text-ink-3">
          You&apos;ll set the recipe (what it&apos;s made from) next.
        </p>
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={save}
            disabled={!name.trim() || busy}
            className="flex-1"
          >
            {busy ? 'Adding…' : 'Add prep item'}
          </Button>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Fetches the item's recipe, scales consumption to the planned yield live, and
 *  flags a shortfall before the server ever blocks it. */
function PrepareBatchSheet({
  itemId,
  onClose,
  onDone,
}: {
  itemId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();
  const [detail, setDetail] = useState<PrepItemDetail | null>(null);
  const [planned, setPlanned] = useState('');
  const [actual, setActual] = useState('');
  const [expiry, setExpiry] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Fetch on open; every state write is in the async callback (never
  // synchronously in the effect body). Content is gated on detail.id === itemId
  // below, so a stale detail from a previous open never flashes.
  useEffect(() => {
    if (!itemId || !accessToken) return;
    let cancelled = false;
    getPrepItem(accessToken, onNewToken, itemId)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setPlanned(d.prepBatchYield ? String(d.prepBatchYield) : '');
        setActual('');
        setExpiry('');
        setNote('');
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          toast({
            title: e instanceof ApiRequestError ? e.message : 'Could not load the recipe',
            variant: 'danger',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [itemId, accessToken, onNewToken, toast]);

  const ready = detail && detail.id === itemId;
  const plannedNum = Math.round(Number(planned));
  const validPlanned = Number.isFinite(plannedNum) && plannedNum > 0;

  // Scale each component to the planned yield (mirrors the server) and flag a
  // shortfall. Purely a preview — the server re-checks and is authoritative.
  const preview = useMemo(() => {
    if (!detail?.prepBatchYield || !validPlanned) return [];
    return detail.recipe.map((c) => {
      const need = Math.round((c.quantity * plannedNum) / detail.prepBatchYield!);
      return { ...c, need, short: need > c.available };
    });
  }, [detail, plannedNum, validPlanned]);
  const anyShort = preview.some((p) => p.short);

  async function prepare() {
    if (!accessToken || !itemId || !validPlanned || busy || anyShort) return;
    setBusy(true);
    try {
      const actualNum = actual.trim() ? Math.round(Number(actual)) : plannedNum;
      await createPrepBatch(accessToken, onNewToken, itemId, {
        quantity: plannedNum,
        ...(actual.trim() && Number.isFinite(actualNum)
          ? { actualQuantity: actualNum }
          : {}),
        ...(expiry ? { expiresAt: new Date(expiry).toISOString() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        idempotencyKey:
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random()}`,
      });
      toast({ title: 'Batch prepared', variant: 'success' });
      onDone();
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not prepare the batch',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  const unit = detail?.unit ?? 'GRAM';

  return (
    <Sheet open={itemId !== null} onClose={onClose} title={ready ? `Prepare ${detail.name}` : 'Prepare batch'}>
      {!ready ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="space-y-4">
          <Field label={`Batch size (${unitLabel(unit)})`}>
            <Input
              inputMode="numeric"
              value={planned}
              onChange={(e) => setPlanned(e.target.value)}
              placeholder={detail.prepBatchYield ? String(detail.prepBatchYield) : '0'}
              autoFocus
            />
          </Field>

          <div>
            <p className="text-label mb-1.5">Will consume</p>
            {preview.length === 0 ? (
              <p className="text-[13px] text-ink-3">Enter a batch size.</p>
            ) : (
              <ul className="space-y-1">
                {preview.map((p) => (
                  <li
                    key={p.ingredientId}
                    className={cn(
                      'flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[13px]',
                      p.short ? 'bg-danger-surface' : 'bg-surface-2',
                    )}
                  >
                    <span className="min-w-0 truncate">{p.name}</span>
                    <span className="flex shrink-0 items-center gap-2 tabular-nums">
                      <span className={cn(p.short && 'font-semibold text-danger-text')}>
                        {formatQuantity(p.need, p.unit)}
                      </span>
                      {p.short && (
                        <span className="text-[11px] text-danger-text">
                          have {formatQuantity(p.available, p.unit)}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {anyShort && (
              <p className="mt-2 flex items-center gap-1.5 text-[12px] text-danger-text">
                <AlertTriangle aria-hidden className="size-3.5" />
                Not enough stock — receive or adjust it first.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label={`Actual yield (${unitLabel(unit)})`}>
              <Input
                inputMode="numeric"
                value={actual}
                onChange={(e) => setActual(e.target.value)}
                placeholder={validPlanned ? String(plannedNum) : ''}
              />
            </Field>
            <Field label="Expires (optional)">
              <Input
                type="datetime-local"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
            </Field>
          </div>

          <Button
            variant="primary"
            size="lg"
            onClick={prepare}
            disabled={!validPlanned || anyShort || busy}
            className="w-full"
          >
            {busy ? 'Preparing…' : 'Create batch'}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

function DetailSheet({
  itemId,
  ingredients,
  onClose,
  onChanged,
  onPrepare,
}: {
  itemId: string | null;
  ingredients: IngredientRow[];
  onClose: () => void;
  onChanged: () => void;
  onPrepare: (id: string) => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();
  const [detail, setDetail] = useState<PrepItemDetail | null>(null);
  const [editingRecipe, setEditingRecipe] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Fetch on open/refresh; all state writes are in the async callback. Loading
  // an item is always a "view mode" moment, so editing resets there.
  useEffect(() => {
    if (!itemId || !accessToken) return;
    let cancelled = false;
    getPrepItem(accessToken, onNewToken, itemId)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setEditingRecipe(false);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          toast({
            title: e instanceof ApiRequestError ? e.message : 'Could not load the item',
            variant: 'danger',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [itemId, accessToken, onNewToken, toast, reloadKey]);

  const ready = detail && detail.id === itemId;
  const refresh = () => {
    setReloadKey((k) => k + 1);
    onChanged();
  };

  return (
    <Sheet open={itemId !== null} onClose={onClose} title={ready ? detail.name : 'Prep item'}>
      {!ready ? (
        <Skeleton className="h-48" />
      ) : editingRecipe ? (
        <RecipeEditor
          detail={detail}
          ingredients={ingredients}
          onCancel={() => setEditingRecipe(false)}
          onSaved={() => {
            setEditingRecipe(false);
            refresh();
          }}
        />
      ) : (
        <div className="space-y-5">
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] text-ink-2">Available</span>
            <span className="text-[15px] font-semibold tabular-nums">
              {formatQuantity(detail.available, detail.unit)}
            </span>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-label">Recipe</p>
              <Button variant="ghost" size="sm" onClick={() => setEditingRecipe(true)}>
                {detail.recipe.length ? 'Edit' : 'Set recipe'}
              </Button>
            </div>
              {detail.recipe.length === 0 ? (
                <p className="text-[13px] text-ink-3">
                  No recipe yet — set what this is made from to prepare batches.
                </p>
              ) : (
                <>
                  <p className="mb-1 text-[12px] text-ink-3">
                    Makes {formatQuantity(detail.prepBatchYield ?? 0, detail.unit)} per batch
                    {detail.recipeCostMinor !== null && (
                      <> · costs {formatMinor(detail.recipeCostMinor)}</>
                    )}
                  </p>
                  <ul className="space-y-1">
                    {detail.recipe.map((c) => (
                      <li
                        key={c.ingredientId}
                        className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[13px]"
                      >
                        <span className="min-w-0 truncate">
                          {c.name}
                          {!c.isActive && (
                            <span className="ml-1.5 text-[11px] text-danger-text">
                              inactive
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 tabular-nums text-ink-2">
                          {formatQuantity(c.quantity, c.unit)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

          {detail.recipe.length > 0 && (
            <Button
              variant="primary"
              onClick={() => onPrepare(detail.id)}
              className="w-full"
            >
              <ChefHat aria-hidden className="size-4" />
              Prepare batch
            </Button>
          )}

          <div>
            <p className="text-label mb-1.5">Batches</p>
            {detail.batches.length === 0 ? (
              <p className="text-[13px] text-ink-3">No batches yet.</p>
            ) : (
              <ul className="space-y-2">
                {detail.batches.map((b) => (
                  <BatchRow
                    key={b.id}
                    batch={b}
                    unit={detail.unit}
                    onWasted={refresh}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}

function BatchRow({
  batch,
  unit,
  onWasted,
}: {
  batch: PrepItemDetail['batches'][number];
  unit: StockUnit;
  onWasted: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();
  const [wasting, setWasting] = useState(false);
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);

  const expiresLabel = batch.expiresAt
    ? new Date(batch.expiresAt).toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;

  async function waste() {
    const n = Math.round(Number(qty));
    if (!accessToken || !Number.isFinite(n) || n <= 0 || busy) return;
    setBusy(true);
    try {
      await wastePrepBatch(accessToken, onNewToken, batch.id, { quantity: n });
      toast({ title: 'Waste recorded', variant: 'success' });
      setWasting(false);
      setQty('');
      onWasted();
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not record waste',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl border border-line p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[13px] font-medium">
            <span className="truncate">{batch.code}</span>
            {batch.expired && batch.remaining > 0 && <Badge variant="danger">Expired</Badge>}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-3">
            <span className="tabular-nums text-ink-2">
              {formatQuantity(batch.remaining, unit)} left
            </span>
            <span>of {formatQuantity(batch.actualQuantity, unit)}</span>
            {expiresLabel && (
              <span className="flex items-center gap-1">
                <Clock aria-hidden className="size-3" />
                {expiresLabel}
              </span>
            )}
            {batch.variance.pct !== null && batch.variance.delta !== 0 && (
              <span className={cn(batch.variance.delta < 0 && 'text-warning-text')}>
                yield {batch.variance.pct > 0 ? '+' : ''}
                {batch.variance.pct}%
              </span>
            )}
          </p>
        </div>
        {batch.remaining > 0 && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Waste from ${batch.code}`}
            onClick={() => setWasting((w) => !w)}
            className="w-8 shrink-0 px-0 text-danger-text"
          >
            <Trash2 aria-hidden className="size-4" />
          </Button>
        )}
      </div>

      {wasting && (
        <div className="mt-2 flex items-end gap-2">
          <div className="flex-1">
            <Field label={`Waste (${unitLabel(unit)})`}>
              <Input
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                placeholder="0"
                autoFocus
              />
            </Field>
          </div>
          <Button variant="danger" onClick={waste} disabled={busy}>
            {busy ? '…' : 'Waste'}
          </Button>
        </div>
      )}
    </li>
  );
}

function RecipeEditor({
  detail,
  ingredients,
  onCancel,
  onSaved,
}: {
  detail: PrepItemDetail;
  ingredients: IngredientRow[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();
  const [batchYield, setBatchYield] = useState(
    detail.prepBatchYield ? String(detail.prepBatchYield) : '',
  );
  const [items, setItems] = useState<Array<{ ingredientId: string; quantity: number }>>(
    detail.recipe.map((c) => ({ ingredientId: c.ingredientId, quantity: c.quantity })),
  );
  const [busy, setBusy] = useState(false);

  // Any active ingredient except this item itself (raw or another prep item, for
  // multi-level). The server also rejects self and the direct reciprocal.
  const options = useMemo(
    () => ingredients.filter((i) => i.isActive && i.id !== detail.id),
    [ingredients, detail.id],
  );
  const nameOf = (id: string) => options.find((o) => o.id === id)?.name ?? '—';
  const unitOf = (id: string): StockUnit =>
    options.find((o) => o.id === id)?.unit ?? 'GRAM';

  const yieldNum = Math.round(Number(batchYield));
  const valid = Number.isFinite(yieldNum) && yieldNum > 0 && items.length > 0;

  function addItem(id: string) {
    if (!id) return;
    setItems((cur) =>
      cur.some((i) => i.ingredientId === id)
        ? cur
        : [...cur, { ingredientId: id, quantity: 1 }],
    );
  }

  async function save() {
    if (!accessToken || !valid || busy) return;
    setBusy(true);
    try {
      await setPrepRecipe(accessToken, onNewToken, detail.id, {
        batchYield: yieldNum,
        items,
      });
      toast({ title: 'Recipe saved', variant: 'success' });
      onSaved();
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not save the recipe',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Field label={`One batch makes (${unitLabel(detail.unit)})`}>
        <Input
          inputMode="numeric"
          value={batchYield}
          onChange={(e) => setBatchYield(e.target.value)}
          placeholder="1000"
        />
      </Field>

      <div>
        <p className="text-label mb-1.5">Made from</p>
        {items.length === 0 && (
          <p className="text-[13px] text-ink-3">Add the ingredients it uses.</p>
        )}
        <ul className="space-y-1.5">
          {items.map((i) => (
            <li
              key={i.ingredientId}
              className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[13px]"
            >
              <span className="min-w-0 truncate">{nameOf(i.ingredientId)}</span>
              <span className="flex shrink-0 items-center gap-2">
                <Input
                  inputMode="numeric"
                  value={String(i.quantity)}
                  onChange={(e) => {
                    const q = Math.round(Number(e.target.value));
                    setItems((cur) =>
                      cur.map((x) =>
                        x.ingredientId === i.ingredientId
                          ? { ...x, quantity: Number.isFinite(q) && q > 0 ? q : 1 }
                          : x,
                      ),
                    );
                  }}
                  aria-label={`Quantity of ${nameOf(i.ingredientId)}`}
                  className="h-8 w-16"
                />
                <span className="w-8 text-[11px] text-ink-3">{unitLabel(unitOf(i.ingredientId))}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${nameOf(i.ingredientId)}`}
                  onClick={() =>
                    setItems((cur) => cur.filter((x) => x.ingredientId !== i.ingredientId))
                  }
                  className="w-7 px-0 text-danger-text"
                >
                  <Trash2 aria-hidden className="size-4" />
                </Button>
              </span>
            </li>
          ))}
        </ul>
        <Select
          value=""
          onChange={(e) => addItem(e.target.value)}
          aria-label="Add a component"
          className="mt-2"
        >
          <option value="">+ Add an ingredient…</option>
          {options
            .filter((o) => !items.some((i) => i.ingredientId === o.id))
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
        </Select>
      </div>

      <div className="flex gap-2">
        <Button variant="primary" onClick={save} disabled={!valid || busy} className="flex-1">
          {busy ? 'Saving…' : 'Save recipe'}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
