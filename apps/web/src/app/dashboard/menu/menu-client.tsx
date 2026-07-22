'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Coins,
  FolderPlus,
  Plus,
  Search,
  SearchX,
  Tags,
  Trash2,
} from 'lucide-react';
import {
  ApiRequestError,
  createCategory,
  createProduct,
  deleteCategory,
  getProductCosting,
  listCategories,
  listProducts,
  reorderCategories,
  updateCategory,
  updateProduct,
  type Category,
  type Product,
  type ProductCosting,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatMinor, parseRupeesToMinor } from '@/lib/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';

/**
 * Menu — where the catalogue is actually managed. POS sells it; this screen
 * changes it. Edits never touch past orders: order_items snapshot name, price
 * and tax at sale time, so repricing today cannot rewrite yesterday's revenue.
 */

const FILTERS = [
  { key: 'ACTIVE', label: 'Active' },
  { key: 'INACTIVE', label: 'Inactive' },
  { key: 'ALL', label: 'All' },
] as const;
type FilterKey = (typeof FILTERS)[number]['key'];

/** "5" or "12.5" (percent) → basis points, or null when not a valid rate. */
function parsePercentToBp(input: string): number | null {
  const t = input.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const bp = Math.round(Number(t) * 100);
  return bp >= 0 && bp <= 10_000 ? bp : null;
}

const bpToPercent = (bp: number) => String(bp / 100).replace(/\.0+$/, '');

export function MenuClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [products, setProducts] = useState<Product[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [filter, setFilter] = useState<FilterKey>('ACTIVE');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [costsOpen, setCostsOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const tokenRef = useRef(accessToken);
  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    Promise.all([
      listProducts(accessToken, onNewToken, true),
      listCategories(accessToken, onNewToken),
    ])
      .then(([p, c]) => {
        if (cancelled) return;
        setProducts(p);
        setCategories(c);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          toast({
            title: e instanceof ApiRequestError ? e.message : 'Could not load the menu',
            variant: 'danger',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, reloadKey, toast]);

  const catName = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name])),
    [categories],
  );

  const loading = products === null;
  const all = useMemo(() => products ?? [], [products]);

  const productCountByCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of all) {
      if (p.categoryId) m.set(p.categoryId, (m.get(p.categoryId) ?? 0) + 1);
    }
    return m;
  }, [all]);
  const needle = q.trim().toLowerCase();
  const rows = all.filter((p) => {
    if (filter === 'ACTIVE' && !p.isActive) return false;
    if (filter === 'INACTIVE' && p.isActive) return false;
    if (!needle) return true;
    const cn2 = p.categoryId ? (catName.get(p.categoryId) ?? '') : '';
    return (
      p.name.toLowerCase().includes(needle) || cn2.toLowerCase().includes(needle)
    );
  });
  const inactiveCount = all.filter((p) => !p.isActive).length;

  async function toggleActive(p: Product) {
    const token = tokenRef.current;
    if (!token) return;
    try {
      await updateProduct(token, onNewToken, p.id, { isActive: !p.isActive });
      toast({
        title: p.isActive ? `${p.name} removed from the menu` : `${p.name} is back on the menu`,
        variant: 'success',
      });
      reload();
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not update the item',
        variant: 'danger',
      });
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Menu</h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setCostsOpen(true)}>
            <Coins aria-hidden className="size-4" />
            Food cost
          </Button>
          <Button variant="secondary" onClick={() => setCategoriesOpen(true)}>
            <Tags aria-hidden className="size-4" />
            Categories
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus aria-hidden className="size-4" />
            New item
          </Button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Segmented options={FILTERS} value={filter} onChange={setFilter} />
        <div className="relative min-w-0 flex-1 basis-52 sm:max-w-xs">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3"
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQ('');
            }}
            placeholder="Search items…"
            aria-label="Search menu items"
            className="pl-9"
          />
        </div>
        {inactiveCount > 0 && filter === 'ACTIVE' && (
          <p className="text-[12px] text-ink-3 tabular-nums">
            {inactiveCount} inactive item{inactiveCount === 1 ? '' : 's'} hidden
          </p>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
        {loading ? (
          <div className="space-y-2 p-4" aria-label="Loading menu">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          all.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="No menu items yet"
              body="Add your first item — it appears on the POS instantly."
              action={
                <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                  Add an item
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={SearchX}
              title="No matching items"
              body="Nothing on the menu matches these filters."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setFilter('ALL');
                    setQ('');
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          )
        ) : (
          <Table containerClassName="max-h-[calc(100dvh-16.5rem)] overflow-y-auto rounded-xl">
            <thead>
              <tr>
                <Th>Item</Th>
                <Th className="hidden sm:table-cell">Category</Th>
                <Th numeric>Price</Th>
                <Th numeric className="hidden md:table-cell">
                  Tax
                </Th>
                <Th>Status</Th>
                <Th className="w-px" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <Tr
                  key={p.id}
                  onClick={() => setEditing(p)}
                  aria-selected={editing?.id === p.id}
                  className={cn(
                    'animate-fade-up',
                    editing?.id === p.id && 'bg-surface-2',
                    !p.isActive && 'opacity-60',
                  )}
                >
                  <Td>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(p);
                      }}
                      className="rounded font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                    >
                      {p.name}
                    </button>
                  </Td>
                  <Td className="hidden max-w-40 truncate text-ink-2 sm:table-cell">
                    {p.categoryId ? (
                      (catName.get(p.categoryId) ?? '—')
                    ) : (
                      <span className="text-ink-3">Uncategorised</span>
                    )}
                  </Td>
                  <Td numeric className="font-medium">
                    {formatMinor(p.priceMinor)}
                  </Td>
                  <Td numeric className="hidden text-ink-2 md:table-cell">
                    {bpToPercent(p.taxRateBp)}%
                  </Td>
                  <Td>
                    <Badge variant={p.isActive ? 'success' : 'neutral'}>
                      {p.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </Td>
                  <Td className="py-1.5 text-right">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggleActive(p);
                      }}
                    >
                      {p.isActive ? 'Deactivate' : 'Reactivate'}
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
      {!loading && rows.length > 0 && (
        <p className="mt-2 text-[12px] text-ink-3 tabular-nums">
          {rows.length} item{rows.length === 1 ? '' : 's'}
        </p>
      )}

      <ProductModal
        open={creating}
        onClose={() => setCreating(false)}
        categories={categories}
        onSaved={() => {
          setCreating(false);
          reload();
        }}
      />

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.name ?? 'Item'}
      >
        {editing && (
          <EditProduct
            key={editing.id}
            product={editing}
            categories={categories}
            onSaved={() => {
              setEditing(null);
              reload();
            }}
            onToggled={() => {
              setEditing(null);
              reload();
            }}
          />
        )}
      </Sheet>

      <CategoriesSheet
        open={categoriesOpen}
        onClose={() => setCategoriesOpen(false)}
        categories={categories}
        productCountByCategory={productCountByCategory}
        onChanged={reload}
      />

      <FoodCostSheet open={costsOpen} onClose={() => setCostsOpen(false)} />
    </div>
  );
}

/* -------------------------------------------------------------- food cost */

function FoodCostSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Food cost">
      <p className="mb-4 text-[12px] text-ink-3">
        Recipe cost from your weighted-average ingredient costs, and the margin
        against each item&apos;s price. Add ingredient costs on the Inventory
        screen to fill this in.
      </p>
      {/* Mounted only while open, so the fetch runs on open and its result
          lands in a callback — no synchronous reset needed. */}
      {open && <FoodCostBody />}
    </Sheet>
  );
}

function FoodCostBody() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [rows, setRows] = useState<ProductCosting[] | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    getProductCosting(accessToken, onNewToken)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          toast({
            title: e instanceof ApiRequestError ? e.message : 'Could not load food cost',
            variant: 'danger',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, toast]);

  return (
    <>
      {rows === null ? (
        <div className="space-y-2" aria-label="Loading food cost">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Coins}
          title="No items yet"
          body="Add menu items and give them recipes to see food cost and margin."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Item</Th>
              <Th numeric>Price</Th>
              <Th numeric>Cost</Th>
              <Th numeric>Food %</Th>
              <Th numeric>Margin</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td className="max-w-40 truncate">{r.name}</Td>
                <Td numeric>{formatMinor(r.priceMinor)}</Td>
                <Td numeric>
                  {r.recipeCostMinor === null ? (
                    <span className="text-ink-3" title={r.hasRecipe ? 'Missing ingredient cost' : 'No recipe'}>
                      —
                    </span>
                  ) : (
                    formatMinor(r.recipeCostMinor)
                  )}
                </Td>
                <Td numeric>
                  {r.foodCostPct === null ? (
                    <span className="text-ink-3">—</span>
                  ) : (
                    <span
                      className={cn(
                        // Rule of thumb: food cost above ~35% eats the margin.
                        r.foodCostPct > 35 ? 'text-danger-text' : 'text-ink-2',
                      )}
                    >
                      {r.foodCostPct}%
                    </span>
                  )}
                </Td>
                <Td numeric>
                  {r.marginMinor === null ? (
                    <span className="text-ink-3">—</span>
                  ) : (
                    <span className={cn(r.marginMinor < 0 && 'text-danger-text')}>
                      {formatMinor(r.marginMinor)}
                    </span>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- products */

function ProductFields({
  name,
  setName,
  price,
  setPrice,
  tax,
  setTax,
  categoryId,
  setCategoryId,
  categories,
}: {
  name: string;
  setName: (v: string) => void;
  price: string;
  setPrice: (v: string) => void;
  tax: string;
  setTax: (v: string) => void;
  categoryId: string;
  setCategoryId: (v: string) => void;
  categories: Category[];
}) {
  return (
    <>
      <Field label="Item name">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Price (₹)">
          <Input
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="120.00"
          />
        </Field>
        <Field label="Tax rate (%)">
          <Input
            inputMode="decimal"
            value={tax}
            onChange={(e) => setTax(e.target.value)}
            placeholder="5"
          />
        </Field>
      </div>
      <Field label="Category">
        <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Uncategorised</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}

function ProductModal({
  open,
  onClose,
  categories,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  categories: Category[];
  onSaved: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [tax, setTax] = useState('5');
  const [categoryId, setCategoryId] = useState('');
  const [busy, setBusy] = useState(false);

  const priceMinor = parseRupeesToMinor(price);
  const taxBp = parsePercentToBp(tax);
  const valid = name.trim().length > 0 && priceMinor !== null && taxBp !== null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !valid) return;
    setBusy(true);
    try {
      await createProduct(accessToken, onNewToken, {
        name: name.trim(),
        priceMinor: priceMinor!,
        taxRateBp: taxBp!,
        ...(categoryId ? { categoryId } : {}),
      });
      toast({ title: `${name.trim()} added to the menu`, variant: 'success' });
      setName('');
      setPrice('');
      setTax('5');
      setCategoryId('');
      onSaved();
    } catch (err) {
      toast({
        title: err instanceof ApiRequestError ? err.message : 'Could not add the item',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New menu item">
      <form onSubmit={submit} className="space-y-4">
        <ProductFields
          name={name}
          setName={setName}
          price={price}
          setPrice={setPrice}
          tax={tax}
          setTax={setTax}
          categoryId={categoryId}
          setCategoryId={setCategoryId}
          categories={categories}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!valid || busy}>
            {busy ? 'Adding…' : 'Add item'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function EditProduct({
  product,
  categories,
  onSaved,
  onToggled,
}: {
  product: Product;
  categories: Category[];
  onSaved: () => void;
  onToggled: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [name, setName] = useState(product.name);
  const [price, setPrice] = useState((product.priceMinor / 100).toFixed(2));
  const [tax, setTax] = useState(bpToPercent(product.taxRateBp));
  const [categoryId, setCategoryId] = useState(product.categoryId ?? '');
  const [busy, setBusy] = useState(false);

  const priceMinor = parseRupeesToMinor(price);
  const taxBp = parsePercentToBp(tax);
  const valid = name.trim().length > 0 && priceMinor !== null && taxBp !== null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !valid) return;
    setBusy(true);
    try {
      await updateProduct(accessToken, onNewToken, product.id, {
        name: name.trim(),
        priceMinor: priceMinor!,
        taxRateBp: taxBp!,
        categoryId: categoryId || null,
      });
      toast({ title: 'Item updated', variant: 'success' });
      onSaved();
    } catch (err) {
      toast({
        title: err instanceof ApiRequestError ? err.message : 'Could not save the item',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    if (!accessToken) return;
    setBusy(true);
    try {
      await updateProduct(accessToken, onNewToken, product.id, {
        isActive: !product.isActive,
      });
      toast({
        title: product.isActive
          ? 'Item removed from the menu'
          : 'Item is back on the menu',
        variant: 'success',
      });
      onToggled();
    } catch (err) {
      toast({
        title: err instanceof ApiRequestError ? err.message : 'Could not update the item',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge variant={product.isActive ? 'success' : 'neutral'}>
          {product.isActive ? 'Active' : 'Inactive'}
        </Badge>
        <span className="text-[12px] text-ink-3">
          Past orders keep the price they were sold at.
        </span>
      </div>

      <ProductFields
        name={name}
        setName={setName}
        price={price}
        setPrice={setPrice}
        tax={tax}
        setTax={setTax}
        categoryId={categoryId}
        setCategoryId={setCategoryId}
        categories={categories}
      />

      <Button variant="primary" type="submit" disabled={!valid || busy} className="w-full">
        {busy ? 'Saving…' : 'Save changes'}
      </Button>

      <div className="border-t border-line pt-4">
        <p className="mb-2 text-[12px] text-ink-3">
          {product.isActive
            ? 'Deactivating hides the item from the POS. Its sales history stays.'
            : 'Reactivating puts the item back on the POS immediately.'}
        </p>
        <Button
          type="button"
          variant={product.isActive ? 'danger' : 'secondary'}
          disabled={busy}
          onClick={() => void toggle()}
          className="w-full"
        >
          {product.isActive ? 'Deactivate item' : 'Reactivate item'}
        </Button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------- categories */

function CategoriesSheet({
  open,
  onClose,
  categories,
  productCountByCategory,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  categories: Category[];
  productCountByCategory: Map<string, number>;
  onChanged: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  // Only EDITED names live here; everything else falls back to the canonical
  // list, so no effect is needed to keep the two in sync.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Category | null>(null);

  const clearDraft = (id: string) =>
    setDrafts((d) => {
      const rest = { ...d };
      delete rest[id];
      return rest;
    });

  const err = (e: unknown, fallback: string) =>
    toast({
      title: e instanceof ApiRequestError ? e.message : fallback,
      variant: 'danger',
    });

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !newName.trim()) return;
    setBusy(true);
    try {
      await createCategory(accessToken, onNewToken, newName.trim());
      setNewName('');
      onChanged();
    } catch (e2) {
      err(e2, 'Could not add the category');
    } finally {
      setBusy(false);
    }
  }

  async function rename(c: Category) {
    const draft = drafts[c.id]?.trim();
    if (!accessToken || draft === undefined) return;
    if (!draft || draft === c.name) {
      clearDraft(c.id);
      return;
    }
    setBusy(true);
    try {
      await updateCategory(accessToken, onNewToken, c.id, { name: draft });
      clearDraft(c.id);
      onChanged();
    } catch (e2) {
      err(e2, 'Could not rename the category');
      clearDraft(c.id);
    } finally {
      setBusy(false);
    }
  }

  async function move(index: number, delta: -1 | 1) {
    if (!accessToken) return;
    const next = [...categories];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setBusy(true);
    try {
      await reorderCategories(accessToken, onNewToken, next.map((c) => c.id));
      onChanged();
    } catch (e2) {
      err(e2, 'Could not reorder');
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: Category) {
    if (!accessToken) return;
    setBusy(true);
    try {
      await deleteCategory(accessToken, onNewToken, c.id);
      toast({ title: `${c.name} deleted`, variant: 'success' });
      onChanged();
    } catch (e2) {
      err(e2, 'Could not delete the category');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Categories">
      <div className="space-y-5">
        <p className="text-[12px] text-ink-3">
          Categories group the POS grid. Deleting one keeps its items on the
          menu as Uncategorised.
        </p>

        {categories.length === 0 ? (
          <EmptyState
            icon={FolderPlus}
            title="No categories yet"
            body="Add one below — then assign items to it from the menu list."
          />
        ) : (
          <ul className="space-y-2">
            {categories.map((c, i) => (
              <li key={c.id} className="flex items-center gap-1.5">
                <div className="flex flex-col">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Move ${c.name} up`}
                    disabled={busy || i === 0}
                    onClick={() => void move(i, -1)}
                    className="h-4 w-6 px-0"
                  >
                    <ArrowUp aria-hidden className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Move ${c.name} down`}
                    disabled={busy || i === categories.length - 1}
                    onClick={() => void move(i, 1)}
                    className="h-4 w-6 px-0"
                  >
                    <ArrowDown aria-hidden className="size-3" />
                  </Button>
                </div>
                <Input
                  value={drafts[c.id] ?? c.name}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [c.id]: e.target.value }))
                  }
                  onBlur={() => void rename(c)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void rename(c);
                    }
                  }}
                  aria-label={`Rename ${c.name}`}
                  maxLength={60}
                  className="h-8 flex-1 text-[13px]"
                />
                <span className="w-14 shrink-0 text-right text-[11px] text-ink-3 tabular-nums">
                  {productCountByCategory.get(c.id) ?? 0} item
                  {(productCountByCategory.get(c.id) ?? 0) === 1 ? '' : 's'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete ${c.name}`}
                  disabled={busy}
                  onClick={() => setConfirmDelete(c)}
                  className="w-7 px-0 text-ink-3 hover:text-danger"
                >
                  <Trash2 aria-hidden className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={add} className="flex items-end gap-2 border-t border-line pt-4">
          <div className="flex-1">
            <Field label="New category">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={60}
                placeholder="e.g. Momos"
              />
            </Field>
          </div>
          <Button type="submit" variant="secondary" disabled={!newName.trim() || busy}>
            Add
          </Button>
        </form>
      </div>

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) void remove(confirmDelete);
          setConfirmDelete(null);
        }}
        title={`Delete “${confirmDelete?.name}”?`}
        body={`Items in this category stay on the menu as Uncategorised. ${
          productCountByCategory.get(confirmDelete?.id ?? '') ?? 0
        } item(s) affected.`}
        confirmLabel="Delete category"
      />
    </Sheet>
  );
}
