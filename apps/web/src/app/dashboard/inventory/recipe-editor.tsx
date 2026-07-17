'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiRequestError,
  getRecipe,
  listProducts,
  setRecipe,
  type IngredientRow,
  type Product,
} from '@/lib/api';
import { unitLabel } from '@/lib/units';

/**
 * Recipes live on the Inventory screen rather than the menu, because a recipe
 * is a statement about stock, not about price. It is also the only thing that
 * makes depletion automatic — without it, inventory is manual forever.
 */
export function RecipeEditor({
  accessToken,
  onNewToken,
  ingredients,
  setError,
}: {
  accessToken: string | null;
  onNewToken: (t: string) => void;
  ingredients: IngredientRow[];
  setError: (m: string | null) => void;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [items, setItems] = useState<Array<{ ingredientId: string; quantity: number }>>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listProducts(accessToken, onNewToken);
        if (!cancelled) setProducts(list);
      } catch {
        // The inventory list already surfaces API errors; a failure to load
        // the product list should not bury that with a second banner.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken]);

  const load = useCallback(
    async (pid: string) => {
      if (!accessToken || !pid) return;
      setSaved(false);
      try {
        const recipe = await getRecipe(accessToken, onNewToken, pid);
        setItems(
          recipe.items.map((i) => ({
            ingredientId: i.ingredient.id,
            quantity: i.quantity,
          })),
        );
      } catch (e) {
        setError(e instanceof ApiRequestError ? e.message : 'Could not load recipe');
      }
    },
    [accessToken, onNewToken, setError],
  );

  function setQty(ingredientId: string, raw: string) {
    setSaved(false);
    const qty = Number(raw);
    setItems((cur) => {
      const rest = cur.filter((i) => i.ingredientId !== ingredientId);
      // Zero or blank removes the ingredient — the recipe is replaced
      // wholesale, so absence is how you delete.
      if (!raw.trim() || !Number.isInteger(qty) || qty <= 0) return rest;
      return [...rest, { ingredientId, quantity: qty }];
    });
  }

  async function save() {
    if (!accessToken || !productId) return;
    setBusy(true);
    setError(null);
    try {
      await setRecipe(accessToken, onNewToken, productId, items);
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Could not save recipe');
    } finally {
      setBusy(false);
    }
  }

  if (products.length === 0) return null;

  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-sm text-black/60 dark:text-white/60">
        Recipes — what a product consumes
      </summary>

      <div className="mt-3 rounded-lg border border-black/10 p-4 dark:border-white/15">
        <label htmlFor="r-product" className="block text-xs font-medium">
          Product
        </label>
        <select
          id="r-product"
          value={productId}
          onChange={(e) => {
            setProductId(e.target.value);
            void load(e.target.value);
          }}
          className="mt-1 w-full rounded-md border border-black/20 bg-transparent px-2 py-2 text-sm dark:border-white/25"
        >
          <option value="">Select a product…</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        {productId && (
          <>
            <p className="mt-3 text-xs text-black/60 dark:text-white/60">
              Per one sold. Leave blank to exclude.
            </p>
            <ul className="mt-2 space-y-2">
              {ingredients.map((ing) => {
                const current = items.find((i) => i.ingredientId === ing.id);
                return (
                  <li key={ing.id} className="flex items-center gap-2">
                    <label
                      htmlFor={`r-${ing.id}`}
                      className="min-w-0 flex-1 truncate text-sm"
                    >
                      {ing.name}
                    </label>
                    <input
                      id={`r-${ing.id}`}
                      inputMode="numeric"
                      value={current?.quantity ?? ''}
                      onChange={(e) => setQty(ing.id, e.target.value)}
                      className="w-24 rounded-md border border-black/20 bg-transparent px-2 py-1 text-sm dark:border-white/25"
                    />
                    <span className="w-14 text-xs text-black/50 dark:text-white/50">
                      {unitLabel(ing.unit)}
                    </span>
                  </li>
                );
              })}
            </ul>

            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="rounded-md bg-brand px-3 py-2 text-xs font-semibold text-brand-ink hover:brightness-95 disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save recipe'}
              </button>
              {saved && (
                <span role="status" className="text-xs text-green-700 dark:text-green-300">
                  Saved
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </details>
  );
}
