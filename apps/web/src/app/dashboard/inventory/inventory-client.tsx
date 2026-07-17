'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiRequestError,
  createIngredient,
  getIngredient,
  listIngredients,
  recordMovement,
  type IngredientDetail,
  type IngredientRow,
  type StockUnit,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatQuantity, unitLabel } from '@/lib/units';
import { RecipeEditor } from './recipe-editor';

export function InventoryClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback(
    (t: string) => setAccessToken(t),
    [setAccessToken],
  );

  const [rows, setRows] = useState<IngredientRow[]>([]);
  const [lowOnly, setLowOnly] = useState(false);
  const [selected, setSelected] = useState<IngredientDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listIngredients(accessToken, onNewToken, lowOnly);
        if (!cancelled) setRows(list);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof ApiRequestError ? e.message : 'Could not load stock',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, lowOnly, reloadKey]);

  const open = useCallback(
    async (id: string) => {
      if (!accessToken) return;
      setError(null);
      try {
        setSelected(await getIngredient(accessToken, onNewToken, id));
      } catch (e) {
        setError(e instanceof ApiRequestError ? e.message : 'Could not open');
      }
    },
    [accessToken, onNewToken],
  );

  async function stockAction(type: 'PURCHASE' | 'WASTE') {
    if (!accessToken || !selected) return;
    const raw = globalThis.prompt(
      `${type === 'PURCHASE' ? 'Receive' : 'Waste'} how many ${unitLabel(selected.unit)}?`,
    );
    if (!raw) return;
    const qty = Number(raw);
    // The server re-validates; this only avoids a pointless round trip.
    if (!Number.isInteger(qty) || qty <= 0) {
      setError('Enter a whole number greater than zero');
      return;
    }
    try {
      await recordMovement(accessToken, onNewToken, selected.id, {
        type,
        quantity: qty,
      });
      await open(selected.id);
      reload();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Could not record');
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Inventory</h1>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-1">
        <button
          type="button"
          onClick={() => setLowOnly(false)}
          aria-pressed={!lowOnly}
          className={`rounded-md px-3 py-1.5 text-sm ${!lowOnly ? 'bg-black/10 font-medium dark:bg-white/15' : 'hover:bg-black/5 dark:hover:bg-white/10'}`}
        >
          All
        </button>
        <button
          type="button"
          onClick={() => setLowOnly(true)}
          aria-pressed={lowOnly}
          className={`rounded-md px-3 py-1.5 text-sm ${lowOnly ? 'bg-black/10 font-medium dark:bg-white/15' : 'hover:bg-black/5 dark:hover:bg-white/10'}`}
        >
          Low stock
        </button>
      </div>

      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section aria-labelledby="stock-list">
          <h2 id="stock-list" className="sr-only">
            Ingredients
          </h2>

          {rows.length === 0 ? (
            <div className="rounded-lg border border-black/10 p-6 dark:border-white/15">
              <p className="text-sm text-black/70 dark:text-white/70">
                {lowOnly ? 'Nothing is low.' : 'No ingredients yet.'}
              </p>
              {!lowOnly && (
                <AddIngredient
                  accessToken={accessToken}
                  onNewToken={onNewToken}
                  onAdded={reload}
                  setError={setError}
                />
              )}
            </div>
          ) : (
            <>
              <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/15 dark:border-white/15">
                {rows.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => open(r.id)}
                      className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10 ${
                        selected?.id === r.id ? 'bg-black/5 dark:bg-white/10' : ''
                      }`}
                    >
                      <span className="font-medium">{r.name}</span>
                      {/* Low stock is stated in words, not colour alone. */}
                      {r.isLow && (
                        <span className="rounded bg-orange-500/15 px-2 py-0.5 text-xs font-medium text-orange-700 dark:text-orange-300">
                          Low
                        </span>
                      )}
                      <span
                        className={`ml-auto tabular-nums ${r.currentStock < 0 ? 'text-red-700 dark:text-red-300' : ''}`}
                      >
                        {formatQuantity(r.currentStock, r.unit)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <details className="mt-4">
                <summary className="cursor-pointer text-sm text-black/60 dark:text-white/60">
                  Add an ingredient
                </summary>
                <AddIngredient
                  accessToken={accessToken}
                  onNewToken={onNewToken}
                  onAdded={reload}
                  setError={setError}
                />
              </details>

              <RecipeEditor
                accessToken={accessToken}
                onNewToken={onNewToken}
                ingredients={rows}
                setError={setError}
              />
            </>
          )}
        </section>

        <section
          aria-labelledby="stock-detail"
          className="rounded-lg border border-black/10 p-4 dark:border-white/15"
        >
          <h2 id="stock-detail" className="text-sm font-medium">
            {selected ? selected.name : 'Ingredient'}
          </h2>

          {!selected ? (
            <p className="mt-3 text-sm text-black/60 dark:text-white/60">
              Select an ingredient.
            </p>
          ) : (
            <>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {formatQuantity(selected.currentStock, selected.unit)}
              </p>
              {selected.currentStock < 0 && (
                // Negative stock is not hidden: the sale was allowed to happen
                // and the discrepancy is the owner's to resolve.
                <p className="mt-1 text-xs text-red-700 dark:text-red-300">
                  Sold more than was received — check the count.
                </p>
              )}

              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => stockAction('PURCHASE')}
                  className="rounded-md bg-brand px-3 py-2 text-xs font-semibold text-brand-ink hover:brightness-95"
                >
                  Receive
                </button>
                <button
                  type="button"
                  onClick={() => stockAction('WASTE')}
                  className="rounded-md border border-black/20 px-3 py-2 text-xs font-semibold hover:bg-black/5 dark:border-white/25 dark:hover:bg-white/10"
                >
                  Waste
                </button>
              </div>

              <h3 className="mt-6 text-xs font-medium text-black/60 dark:text-white/60">
                Ledger
              </h3>
              <ul className="mt-2 space-y-1 text-xs">
                {selected.movements.map((m) => (
                  <li key={m.id} className="flex justify-between gap-2">
                    <span className="text-black/50 dark:text-white/50">
                      {new Date(m.createdAt).toLocaleDateString()}
                    </span>
                    <span>{m.type.toLowerCase()}</span>
                    <span
                      className={`tabular-nums ${m.quantity < 0 ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`}
                    >
                      {m.quantity > 0 ? '+' : ''}
                      {formatQuantity(m.quantity, selected.unit)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function AddIngredient({
  accessToken,
  onNewToken,
  onAdded,
  setError,
}: {
  accessToken: string | null;
  onNewToken: (t: string) => void;
  onAdded: () => void;
  setError: (m: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<StockUnit>('GRAM');
  const [reorder, setReorder] = useState('');
  const [busy, setBusy] = useState(false);

  const valid = name.trim().length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const level = reorder.trim() ? Number(reorder) : undefined;
      await createIngredient(accessToken, onNewToken, {
        name: name.trim(),
        unit,
        ...(level !== undefined && Number.isInteger(level) && level >= 0
          ? { reorderLevel: level }
          : {}),
      });
      setName('');
      setReorder('');
      onAdded();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not add');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
      <div className="min-w-32 flex-1">
        <label htmlFor="i-name" className="block text-xs font-medium">
          Ingredient
        </label>
        <input
          id="i-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          className="mt-1 w-full rounded-md border border-black/20 bg-transparent px-3 py-2 text-sm dark:border-white/25"
        />
      </div>
      <div className="w-28">
        <label htmlFor="i-unit" className="block text-xs font-medium">
          Unit
        </label>
        <select
          id="i-unit"
          value={unit}
          onChange={(e) => setUnit(e.target.value as StockUnit)}
          className="mt-1 w-full rounded-md border border-black/20 bg-transparent px-2 py-2 text-sm dark:border-white/25"
        >
          <option value="GRAM">grams</option>
          <option value="MILLILITRE">ml</option>
          <option value="PIECE">pieces</option>
        </select>
      </div>
      <div className="w-28">
        <label htmlFor="i-reorder" className="block text-xs font-medium">
          Low at
        </label>
        <input
          id="i-reorder"
          inputMode="numeric"
          value={reorder}
          onChange={(e) => setReorder(e.target.value)}
          placeholder="optional"
          className="mt-1 w-full rounded-md border border-black/20 bg-transparent px-3 py-2 text-sm dark:border-white/25"
        />
      </div>
      <button
        type="submit"
        disabled={!valid || busy}
        className="rounded-md border border-black/20 px-3 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/25"
      >
        Add
      </button>
    </form>
  );
}
