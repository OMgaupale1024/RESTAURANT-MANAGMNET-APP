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
import { useAuth } from '@/lib/auth-context';
import { unitLabel } from '@/lib/units';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';

/**
 * Recipes live on the Inventory screen rather than the menu, because a recipe
 * is a statement about stock, not about price. It is also the only thing that
 * makes depletion automatic — without it, inventory is manual forever.
 */
export function RecipeEditor({
  open,
  onClose,
  ingredients,
}: {
  open: boolean;
  onClose: () => void;
  ingredients: IngredientRow[];
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [items, setItems] = useState<Array<{ ingredientId: string; quantity: number }>>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!accessToken || !open || products.length) return;
    let cancelled = false;
    listProducts(accessToken, onNewToken)
      .then((list) => {
        if (!cancelled) setProducts(list);
      })
      .catch(() => {
        // The page already surfaces API errors; no second banner needed.
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, open, products.length]);

  const load = useCallback(
    (pid: string) => {
      if (!accessToken || !pid) return;
      getRecipe(accessToken, onNewToken, pid)
        .then((recipe) => {
          setItems(
            recipe.items.map((i) => ({
              ingredientId: i.ingredient.id,
              quantity: i.quantity,
            })),
          );
        })
        .catch((e: unknown) => {
          toast({
            title: e instanceof ApiRequestError ? e.message : 'Could not load recipe',
            variant: 'danger',
          });
        });
    },
    [accessToken, onNewToken, toast],
  );

  function setQty(ingredientId: string, raw: string) {
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
    try {
      await setRecipe(accessToken, onNewToken, productId, items);
      toast({ title: 'Recipe saved', variant: 'success' });
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not save recipe',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Recipes — what a product consumes">
      <Field label="Product">
        <Select
          value={productId}
          onChange={(e) => {
            setProductId(e.target.value);
            setItems([]);
            load(e.target.value);
          }}
        >
          <option value="">Select a product…</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>

      {productId && (
        <>
          <p className="mt-3 text-[12px] text-ink-3">
            Quantities per one sold, in base units. Leave blank to exclude.
          </p>
          <ul className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">
            {ingredients.map((ing) => {
              const current = items.find((i) => i.ingredientId === ing.id);
              return (
                <li key={ing.id} className="flex items-center gap-2">
                  <label htmlFor={`r-${ing.id}`} className="min-w-0 flex-1 truncate text-sm">
                    {ing.name}
                  </label>
                  <Input
                    id={`r-${ing.id}`}
                    inputMode="numeric"
                    value={current?.quantity ?? ''}
                    onChange={(e) => setQty(ing.id, e.target.value)}
                    className="w-24"
                  />
                  <span className="w-14 text-[12px] text-ink-3">{unitLabel(ing.unit)}</span>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save recipe'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
