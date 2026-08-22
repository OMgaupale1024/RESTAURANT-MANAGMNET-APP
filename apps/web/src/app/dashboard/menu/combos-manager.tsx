'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Plus, Star, Trash2 } from 'lucide-react';
import {
  ApiRequestError,
  createCombo,
  createUpsellRule,
  deleteCombo,
  deleteUpsellRule,
  listCombos,
  listProducts,
  listUpsellRules,
  updateCombo,
  updateUpsellRule,
  type Combo,
  type Product,
  type UpsellRule,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatMinor, parseRupeesToMinor } from '@/lib/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';

/**
 * Owner/manager editor for combos and upsell rules. Self-contained (own fetch +
 * mutations + toasts); the Menu screen just opens it. Every write hits a
 * product.manage endpoint — the server is the authority on pricing and rules.
 */
export function CombosManager({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [tab, setTab] = useState<'combos' | 'upsells'>('combos');
  const [products, setProducts] = useState<Product[]>([]);
  const [combos, setCombos] = useState<Combo[] | null>(null);
  const [rules, setRules] = useState<UpsellRule[] | null>(null);
  const [editing, setEditing] = useState<Combo | 'new' | null>(null);

  const reload = useCallback(() => {
    if (!accessToken) return;
    Promise.all([
      listProducts(accessToken, onNewToken),
      listCombos(accessToken, onNewToken, true),
      listUpsellRules(accessToken, onNewToken),
    ])
      .then(([p, c, r]) => {
        setProducts(p);
        setCombos(c);
        setRules(r);
      })
      .catch((e) =>
        toast({
          title: e instanceof ApiRequestError ? e.message : 'Could not load combos',
          variant: 'danger',
        }),
      );
  }, [accessToken, onNewToken, toast]);

  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  function fail(e: unknown) {
    toast({
      title: e instanceof ApiRequestError ? e.message : 'Could not save',
      variant: 'danger',
    });
  }

  return (
    <Modal open={open} onClose={onClose} title="Combos & upsells">
      {editing ? (
        <ComboEditor
          combo={editing === 'new' ? null : editing}
          products={products}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      ) : (
        <div className="space-y-4">
          <Segmented
            options={[
              { key: 'combos', label: 'Combos' },
              { key: 'upsells', label: 'Upsells' },
            ]}
            value={tab}
            onChange={setTab}
          />

          {tab === 'combos' ? (
            <CombosList
              combos={combos}
              onEdit={setEditing}
              onNew={() => setEditing('new')}
              onToggle={async (c) => {
                if (!accessToken) return;
                try {
                  await updateCombo(accessToken, onNewToken, c.id, {
                    isActive: !c.isActive,
                  });
                  reload();
                } catch (e) {
                  fail(e);
                }
              }}
              onPopular={async (c) => {
                if (!accessToken) return;
                try {
                  await updateCombo(accessToken, onNewToken, c.id, {
                    isPopular: !c.isPopular,
                  });
                  reload();
                } catch (e) {
                  fail(e);
                }
              }}
              onDelete={async (c) => {
                if (!accessToken) return;
                try {
                  await deleteCombo(accessToken, onNewToken, c.id);
                  toast({ title: `Removed ${c.name}`, variant: 'success' });
                  reload();
                } catch (e) {
                  fail(e);
                }
              }}
            />
          ) : (
            <UpsellsList
              rules={rules}
              products={products}
              onAdd={async (triggerProductId, suggestedProductId) => {
                if (!accessToken) return;
                try {
                  await createUpsellRule(accessToken, onNewToken, {
                    triggerProductId,
                    suggestedProductId,
                  });
                  reload();
                } catch (e) {
                  fail(e);
                }
              }}
              onToggle={async (r) => {
                if (!accessToken) return;
                try {
                  await updateUpsellRule(accessToken, onNewToken, r.id, {
                    isActive: !r.isActive,
                  });
                  reload();
                } catch (e) {
                  fail(e);
                }
              }}
              onDelete={async (r) => {
                if (!accessToken) return;
                try {
                  await deleteUpsellRule(accessToken, onNewToken, r.id);
                  reload();
                } catch (e) {
                  fail(e);
                }
              }}
            />
          )}
        </div>
      )}
    </Modal>
  );
}

function CombosList({
  combos,
  onEdit,
  onNew,
  onToggle,
  onPopular,
  onDelete,
}: {
  combos: Combo[] | null;
  onEdit: (c: Combo) => void;
  onNew: () => void;
  onToggle: (c: Combo) => void;
  onPopular: (c: Combo) => void;
  onDelete: (c: Combo) => void;
}) {
  if (combos === null) return <Skeleton className="h-24" />;
  return (
    <div className="space-y-2">
      {combos.length === 0 && (
        <p className="text-[13px] text-ink-3">
          No combos yet. Bundle a few products at a set price.
        </p>
      )}
      {combos.map((c) => (
        <div
          key={c.id}
          className={cn(
            'rounded-xl border border-line p-3',
            !c.isActive && 'opacity-60',
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 truncate text-[13px] font-semibold">
                {c.name}
                <span className="tabular-nums text-ink-2">
                  {formatMinor(c.priceMinor)}
                </span>
                {!c.available && <Badge variant="danger">Unavailable</Badge>}
              </p>
              <p className="truncate text-[12px] text-ink-3">
                {c.items.map((i) => `${i.quantity}× ${i.product.name}`).join(', ')}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-pressed={c.isPopular}
                title={c.isPopular ? 'Popular' : 'Mark Popular'}
                aria-label={c.isPopular ? `${c.name} is Popular` : `Mark ${c.name} Popular`}
                onClick={() => onPopular(c)}
                className={cn(
                  'rounded p-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current',
                  c.isPopular ? 'text-brand' : 'text-ink-3 hover:text-ink-2',
                )}
              >
                <Star aria-hidden className={cn('size-4', c.isPopular && 'fill-current')} />
              </button>
              <Button variant="secondary" size="sm" onClick={() => onEdit(c)}>
                Edit
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onToggle(c)}>
                {c.isActive ? 'Hide' : 'Show'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Delete ${c.name}`}
                onClick={() => onDelete(c)}
                className="w-7 px-0 text-danger-text"
              >
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      ))}
      <Button variant="secondary" onClick={onNew} className="w-full">
        <Plus aria-hidden className="size-4" />
        Add combo
      </Button>
    </div>
  );
}

function ComboEditor({
  combo,
  products,
  onCancel,
  onSaved,
}: {
  combo: Combo | null;
  products: Product[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();
  const [name, setName] = useState(combo?.name ?? '');
  const [price, setPrice] = useState(
    combo ? (combo.priceMinor / 100).toFixed(2) : '',
  );
  const [isPopular, setIsPopular] = useState(combo?.isPopular ?? false);
  const [items, setItems] = useState<Array<{ productId: string; quantity: number }>>(
    combo?.items.map((i) => ({ productId: i.productId, quantity: i.quantity })) ?? [],
  );
  const [busy, setBusy] = useState(false);

  const priceMinor = parseRupeesToMinor(price);
  const valid =
    name.trim().length > 0 && priceMinor !== null && items.length > 0;

  function addItem(productId: string) {
    if (!productId) return;
    setItems((cur) =>
      cur.some((i) => i.productId === productId)
        ? cur.map((i) =>
            i.productId === productId ? { ...i, quantity: i.quantity + 1 } : i,
          )
        : [...cur, { productId, quantity: 1 }],
    );
  }

  async function save() {
    if (!accessToken || !valid || busy) return;
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        priceMinor: priceMinor!,
        isPopular,
        items: items.map((i, idx) => ({ ...i, sortOrder: idx })),
      };
      if (combo) {
        await updateCombo(accessToken, onNewToken, combo.id, body);
      } else {
        await createCombo(accessToken, onNewToken, body);
      }
      toast({ title: combo ? 'Combo saved' : 'Combo created', variant: 'success' });
      onSaved();
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not save the combo',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  const nameOf = (id: string) => products.find((p) => p.id === id)?.name ?? '—';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-label mb-1.5 block">Combo name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Veg Momos Combo"
          />
        </label>
        <label className="block">
          <span className="text-label mb-1.5 block">Price (₹)</span>
          <Input
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="85"
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={isPopular}
          onChange={(e) => setIsPopular(e.target.checked)}
          className="size-4 accent-[var(--brand)]"
        />
        Show in the POS Popular section
      </label>

      <div>
        <p className="text-label mb-1.5">Components</p>
        <ul className="space-y-1.5">
          {items.map((i) => (
            <li
              key={i.productId}
              className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[13px]"
            >
              <span className="min-w-0 truncate">{nameOf(i.productId)}</span>
              <span className="flex shrink-0 items-center gap-2">
                <Input
                  inputMode="numeric"
                  value={String(i.quantity)}
                  onChange={(e) => {
                    const q = parseInt(e.target.value, 10);
                    setItems((cur) =>
                      cur.map((x) =>
                        x.productId === i.productId
                          ? { ...x, quantity: Number.isFinite(q) && q > 0 ? q : 1 }
                          : x,
                      ),
                    );
                  }}
                  aria-label={`Quantity of ${nameOf(i.productId)}`}
                  className="h-8 w-14"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${nameOf(i.productId)}`}
                  onClick={() =>
                    setItems((cur) => cur.filter((x) => x.productId !== i.productId))
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
          aria-label="Add a component product"
          className="mt-2"
        >
          <option value="">+ Add a product…</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {formatMinor(p.priceMinor)}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex gap-2">
        <Button variant="primary" onClick={save} disabled={!valid || busy} className="flex-1">
          {busy ? 'Saving…' : combo ? 'Save combo' : 'Create combo'}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function UpsellsList({
  rules,
  products,
  onAdd,
  onToggle,
  onDelete,
}: {
  rules: UpsellRule[] | null;
  products: Product[];
  onAdd: (triggerProductId: string, suggestedProductId: string) => void;
  onToggle: (r: UpsellRule) => void;
  onDelete: (r: UpsellRule) => void;
}) {
  const [trigger, setTrigger] = useState('');
  const [suggested, setSuggested] = useState('');
  if (rules === null) return <Skeleton className="h-24" />;

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-ink-3">
        After a product is added, the till suggests one more.
      </p>
      <ul className="space-y-2">
        {rules.map((r) => (
          <li
            key={r.id}
            className={cn(
              'flex items-center justify-between gap-2 rounded-xl border border-line p-3 text-[13px]',
              !r.isActive && 'opacity-60',
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{r.triggerProduct.name}</span>
              <ArrowRight aria-hidden className="size-3.5 shrink-0 text-ink-3" />
              <span className="truncate font-medium">{r.suggestedProduct.name}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => onToggle(r)}>
                {r.isActive ? 'Off' : 'On'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Delete rule"
                onClick={() => onDelete(r)}
                className="w-7 px-0 text-danger-text"
              >
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </span>
          </li>
        ))}
      </ul>

      <div className="rounded-xl border border-dashed border-line p-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-label mb-1.5 block">When added</span>
            <Select value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              <option value="">Choose…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="text-label mb-1.5 block">Suggest</span>
            <Select value={suggested} onChange={(e) => setSuggested(e.target.value)}>
              <option value="">Choose…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            onAdd(trigger, suggested);
            setTrigger('');
            setSuggested('');
          }}
          disabled={!trigger || !suggested || trigger === suggested}
          className="mt-2 w-full"
        >
          <Plus aria-hidden className="size-4" />
          Add suggestion
        </Button>
      </div>
    </div>
  );
}
