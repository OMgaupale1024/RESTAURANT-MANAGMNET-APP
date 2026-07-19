'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Banknote,
  CheckCircle2,
  CreditCard,
  Minus,
  Plus,
  Search,
  SearchX,
  ShoppingCart,
  Smartphone,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import {
  ApiRequestError,
  createOrder,
  createProduct,
  listCategories,
  listProducts,
  type Category,
  type Order,
  type Product,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatMinor, parseRupeesToMinor } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { CustomerPicker } from './customer-picker';

type CartLine = { product: Product; quantity: number };

const METHODS = [
  { key: 'CASH', label: 'Cash', icon: Banknote },
  { key: 'UPI', label: 'UPI', icon: Smartphone },
  { key: 'CARD', label: 'Card', icon: CreditCard },
] as const;
type MethodKey = (typeof METHODS)[number]['key'];

export function PosClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [products, setProducts] = useState<Product[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string>('all');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [coupon, setCoupon] = useState('');
  const [note, setNote] = useState('');
  const [method, setMethod] = useState<MethodKey>('CASH');
  const [placing, setPlacing] = useState(false);
  const [success, setSuccess] = useState<Order | null>(null);
  const [cartOpen, setCartOpen] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  // One idempotency key per order attempt, minted when the cart starts. A
  // double-tapped Charge (or a retried request) then returns the original
  // order instead of ringing the customer up twice.
  const idemKey = useRef<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const [p, c] = await Promise.all([
          listProducts(accessToken, onNewToken),
          listCategories(accessToken, onNewToken),
        ]);
        if (!cancelled) {
          setProducts(p);
          setCategories(c);
        }
      } catch (e) {
        if (!cancelled) {
          toast({
            title: 'Could not load the menu',
            description: e instanceof ApiRequestError ? e.message : undefined,
            variant: 'danger',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, reloadKey, toast]);

  // Keyboard-first: "/" focuses search from anywhere on the page.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const catName = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name])),
    [categories],
  );

  const filtered = useMemo(() => {
    if (!products) return [];
    const needle = q.trim().toLowerCase();
    return products.filter((p) => {
      if (cat !== 'all' && p.categoryId !== cat) return false;
      if (!needle) return true;
      const cn2 = p.categoryId ? (catName.get(p.categoryId) ?? '') : '';
      return (
        p.name.toLowerCase().includes(needle) || cn2.toLowerCase().includes(needle)
      );
    });
  }, [products, q, cat, catName]);

  const qtyById = useMemo(
    () => new Map(cart.map((l) => [l.product.id, l.quantity])),
    [cart],
  );

  const add = useCallback((product: Product) => {
    setCart((c) => {
      if (c.length === 0) idemKey.current = crypto.randomUUID();
      const found = c.find((l) => l.product.id === product.id);
      return found
        ? c.map((l) =>
            l.product.id === product.id ? { ...l, quantity: l.quantity + 1 } : l,
          )
        : [...c, { product, quantity: 1 }];
    });
  }, []);

  const changeQty = useCallback((id: string, delta: number) => {
    setCart((c) =>
      c
        .map((l) => (l.product.id === id ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0),
    );
  }, []);

  const removeLine = useCallback((id: string) => {
    setCart((c) => c.filter((l) => l.product.id !== id));
  }, []);

  const clearCart = useCallback(() => {
    setCart([]);
    setCoupon('');
    setNote('');
    setCustomer(null);
    idemKey.current = null;
  }, []);

  async function charge() {
    if (!accessToken || cart.length === 0 || placing) return;
    setPlacing(true);
    try {
      const order = await createOrder(accessToken, onNewToken, {
        items: cart.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
        paymentMethod: method,
        ...(customer ? { customerId: customer.id } : {}),
        ...(coupon.trim() ? { couponCode: coupon.trim().toUpperCase() } : {}),
        ...(note.trim() ? { notes: note.trim() } : {}),
        idempotencyKey: idemKey.current ?? crypto.randomUUID(),
      });
      setSuccess(order);
      clearCart();
    } catch (e) {
      toast({
        title: 'Could not place the order',
        description: e instanceof ApiRequestError ? e.message : undefined,
        variant: 'danger',
      });
    } finally {
      setPlacing(false);
    }
  }

  // The confirmation stays long enough to read, then the till resets itself.
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 6000);
    return () => clearTimeout(t);
  }, [success]);

  /**
   * Displayed only. The server recomputes every figure from its own prices —
   * these numbers are a preview for the cashier, never an input to the order.
   */
  const subtotal = cart.reduce((s, l) => s + l.product.priceMinor * l.quantity, 0);
  const tax = cart.reduce(
    (s, l) =>
      s + Math.round((l.product.priceMinor * l.quantity * l.product.taxRateBp) / 10_000),
    0,
  );
  const itemCount = cart.reduce((s, l) => s + l.quantity, 0);

  const cartPanel = (
    <CartPanel
      cart={cart}
      subtotal={subtotal}
      tax={tax}
      coupon={coupon}
      setCoupon={setCoupon}
      note={note}
      setNote={setNote}
      method={method}
      setMethod={setMethod}
      placing={placing}
      success={success}
      onNewOrder={() => setSuccess(null)}
      charge={() => void charge()}
      changeQty={changeQty}
      removeLine={removeLine}
      clearCart={clearCart}
      customerSlot={
        <CustomerPicker
          accessToken={accessToken}
          onNewToken={onNewToken}
          customer={customer}
          setCustomer={setCustomer}
          setError={(m) => m && toast({ title: m, variant: 'danger' })}
        />
      }
    />
  );

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] md:h-dvh">
      {/* Menu pane */}
      <section className="flex min-w-0 flex-1 flex-col" aria-label="Menu">
        <div className="shrink-0 space-y-3 border-b border-line px-4 pt-4 pb-3 md:px-6">
          <div className="relative max-w-md">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3"
            />
            <Input
              ref={searchRef}
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQ('');
                // Enter rings up the top match — search, hit enter, done.
                if (e.key === 'Enter' && q.trim() && filtered.length > 0) {
                  add(filtered[0]);
                  setQ('');
                }
              }}
              placeholder="Search menu…"
              aria-label="Search menu"
              className="pl-9 pr-9"
            />
            <kbd className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-[11px] text-ink-3">
              /
            </kbd>
          </div>

          {categories.length > 0 && (
            <div className="flex gap-1.5 overflow-x-auto pb-1" aria-label="Categories">
              {[{ id: 'all', name: 'All' }, ...categories].map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={cat === c.id}
                  onClick={() => setCat(c.id)}
                  className={cn(
                    'h-8 shrink-0 rounded-full border px-3.5 text-[13px] whitespace-nowrap transition-[background-color,border-color,color] duration-120',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current',
                    cat === c.id
                      ? 'border-line-2 bg-surface font-medium text-ink shadow-[0_1px_2px_rgb(0_0_0/0.04)]'
                      : 'border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink',
                  )}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          {!products ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {Array.from({ length: 10 }, (_, i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
          ) : products.length === 0 ? (
            <div className="mx-auto max-w-md">
              <EmptyState
                icon={UtensilsCrossed}
                title="No menu items yet"
                body="Add your first item below — it appears here instantly and you can start selling."
              />
              <AddProduct
                accessToken={accessToken}
                onNewToken={onNewToken}
                onAdded={() => setReloadKey((k) => k + 1)}
              />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title={`No matches for “${q.trim()}”`}
              body="Try a different name, or clear the search."
              action={
                <Button variant="secondary" size="sm" onClick={() => { setQ(''); setCat('all'); }}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {filtered.map((p) => {
                  const qty = qtyById.get(p.id);
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => add(p)}
                        className={cn(
                          'relative flex min-h-24 w-full flex-col justify-between rounded-xl border bg-surface p-3 text-left',
                          'shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[border-color,transform,box-shadow] duration-120',
                          'hover:-translate-y-px hover:border-line-2 hover:shadow-[0_4px_12px_rgb(0_0_0/0.06)]',
                          'active:translate-y-0 active:scale-[0.99]',
                          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current',
                          qty ? 'border-line-2' : 'border-line',
                        )}
                      >
                        <span className="line-clamp-2 pr-6 text-[13px] leading-snug font-medium">
                          {p.name}
                        </span>
                        <span className="mt-2 flex items-baseline justify-between gap-2">
                          <span className="text-[13px] font-semibold tabular-nums">
                            {formatMinor(p.priceMinor)}
                          </span>
                          {p.categoryId && (
                            <span className="truncate text-[11px] text-ink-3">
                              {catName.get(p.categoryId)}
                            </span>
                          )}
                        </span>
                        {qty !== undefined && (
                          <span
                            key={qty}
                            aria-label={`${qty} in cart`}
                            className="absolute top-2 right-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1 text-[11px] font-semibold text-brand-ink tabular-nums"
                            style={{ animation: 'scale-in 160ms var(--ease-out-quart)' }}
                          >
                            {qty}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <details className="mt-6">
                <summary className="cursor-pointer text-[13px] text-ink-3 transition-colors duration-120 hover:text-ink">
                  Add a menu item
                </summary>
                <AddProduct
                  accessToken={accessToken}
                  onNewToken={onNewToken}
                  onAdded={() => setReloadKey((k) => k + 1)}
                />
              </details>
            </>
          )}
        </div>

        {/* Mobile cart bar */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line bg-surface p-3 lg:hidden">
          <p className="text-sm">
            <span className="font-medium tabular-nums">{itemCount}</span>{' '}
            <span className="text-ink-2">{itemCount === 1 ? 'item' : 'items'}</span>
            <span className="ml-2 font-semibold tabular-nums">
              {formatMinor(subtotal + tax)}
            </span>
          </p>
          <Button variant="primary" onClick={() => setCartOpen(true)}>
            <ShoppingCart aria-hidden className="size-4" />
            View order
          </Button>
        </div>
      </section>

      {/* Desktop cart rail */}
      <aside
        className="hidden w-[380px] shrink-0 flex-col border-l border-line bg-surface lg:flex"
        aria-label="Current order"
      >
        {cartPanel}
      </aside>

      {/* Mobile cart sheet */}
      <Sheet
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        side="right"
        className="flex max-w-[400px] flex-col p-0 lg:hidden [&>div:first-child]:px-4 [&>div:first-child]:pt-4"
      >
        {cartPanel}
      </Sheet>
    </div>
  );
}

function CartPanel({
  cart,
  subtotal,
  tax,
  coupon,
  setCoupon,
  note,
  setNote,
  method,
  setMethod,
  placing,
  success,
  onNewOrder,
  charge,
  changeQty,
  removeLine,
  clearCart,
  customerSlot,
}: {
  cart: CartLine[];
  subtotal: number;
  tax: number;
  coupon: string;
  setCoupon: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
  method: MethodKey;
  setMethod: (m: MethodKey) => void;
  placing: boolean;
  success: Order | null;
  onNewOrder: () => void;
  charge: () => void;
  changeQty: (id: string, delta: number) => void;
  removeLine: (id: string) => void;
  clearCart: () => void;
  customerSlot: React.ReactNode;
}) {
  if (success) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <CheckCircle2
          aria-hidden
          className="size-12 text-success-text"
          style={{ animation: 'scale-in 240ms var(--ease-out-quart) both' }}
        />
        <div>
          <p className="text-lg font-semibold">Order #{success.orderNumber} placed</p>
          <p className="mt-1 text-[13px] text-ink-2">Paid by {success.payments[0]?.method ?? '—'}</p>
        </div>
        {/* The server's figures — including any coupon discount it computed. */}
        <dl className="w-full max-w-60 space-y-1.5 text-[13px]">
          <TotalRow label="Subtotal" value={formatMinor(success.subtotalMinor)} />
          {success.discountMinor > 0 && (
            <TotalRow label="Discount" value={`−${formatMinor(success.discountMinor)}`} accent />
          )}
          <TotalRow label="Tax" value={formatMinor(success.taxMinor)} />
          <div className="flex justify-between border-t border-line pt-1.5 text-sm font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{formatMinor(success.totalMinor)}</dd>
          </div>
        </dl>
        <Button variant="primary" onClick={onNewOrder}>
          New order
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">
          Current order
          {cart.length > 0 && (
            <span className="ml-2 text-[12px] font-normal text-ink-3 tabular-nums">
              {(() => {
                const n = cart.reduce((s, l) => s + l.quantity, 0);
                return `${n} item${n === 1 ? '' : 's'}`;
              })()}
            </span>
          )}
        </h2>
        {cart.length > 0 && (
          <Button variant="ghost" size="sm" onClick={clearCart}>
            Clear
          </Button>
        )}
      </div>

      {customerSlot}

      {cart.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={ShoppingCart}
            title="Cart is empty"
            body="Tap a menu item to start the order."
          />
        </div>
      ) : (
        <>
          <ul className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto">
            {cart.map((l) => (
              <li
                key={l.product.id}
                className="animate-fade-up rounded-lg px-1 py-2"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-[13px] font-medium">
                    {l.product.name}
                  </span>
                  <span className="shrink-0 text-[13px] font-medium tabular-nums">
                    {formatMinor(l.product.priceMinor * l.quantity)}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Remove one ${l.product.name}`}
                    onClick={() => changeQty(l.product.id, -1)}
                    className="w-7 px-0"
                  >
                    <Minus aria-hidden className="size-3.5" />
                  </Button>
                  <span
                    key={l.quantity}
                    className="w-7 text-center text-[13px] font-medium tabular-nums"
                    style={{ animation: 'scale-in 140ms var(--ease-out-quart)' }}
                  >
                    {l.quantity}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Add one ${l.product.name}`}
                    onClick={() => changeQty(l.product.id, 1)}
                    className="w-7 px-0"
                  >
                    <Plus aria-hidden className="size-3.5" />
                  </Button>
                  <span className="ml-auto text-[11px] text-ink-3 tabular-nums">
                    @ {formatMinor(l.product.priceMinor)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${l.product.name}`}
                    onClick={() => removeLine(l.product.id)}
                    className="w-7 px-0 text-ink-3"
                  >
                    <X aria-hidden className="size-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <Input
              value={coupon}
              onChange={(e) => setCoupon(e.target.value)}
              placeholder="Coupon code"
              aria-label="Coupon code"
              className="h-8 font-mono text-[12px] uppercase placeholder:font-sans placeholder:normal-case"
            />
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="Order note"
              aria-label="Order note"
              className="h-8 text-[12px]"
            />
          </div>

          <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-[13px]">
            <TotalRow label="Subtotal" value={formatMinor(subtotal)} />
            <TotalRow label="Tax" value={formatMinor(tax)} />
            {coupon.trim() && (
              <p className="text-[11px] text-ink-3">
                Coupon <span className="font-mono uppercase">{coupon.trim()}</span> is
                verified and applied by the server at charge.
              </p>
            )}
            <div className="flex justify-between border-t border-line pt-1.5 text-[15px] font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatMinor(subtotal + tax)}</dd>
            </div>
          </dl>

          <div className="mt-3 grid grid-cols-3 gap-2" aria-label="Payment method">
            {METHODS.map((m) => (
              <button
                key={m.key}
                type="button"
                aria-pressed={method === m.key}
                onClick={() => setMethod(m.key)}
                className={cn(
                  'flex h-12 flex-col items-center justify-center gap-0.5 rounded-lg border text-[12px] font-medium',
                  'transition-[border-color,background-color,color] duration-120',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current',
                  method === m.key
                    ? 'border-ink bg-surface-2 text-ink'
                    : 'border-line-2 text-ink-2 hover:border-line-2 hover:bg-surface-2',
                )}
              >
                <m.icon aria-hidden className="size-4" />
                {m.label}
              </button>
            ))}
          </div>

          <Button
            variant="primary"
            disabled={placing}
            onClick={charge}
            className="mt-2 h-[52px] w-full text-[15px]"
          >
            {placing ? 'Charging…' : `Charge ${formatMinor(subtotal + tax)}`}
          </Button>
        </>
      )}
    </div>
  );
}

function TotalRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-ink-2">{label}</dt>
      <dd className={cn('tabular-nums', accent && 'text-success-text')}>{value}</dd>
    </div>
  );
}

/** Minimal menu entry (existing capability). Full menu management is a later module. */
function AddProduct({
  accessToken,
  onNewToken,
  onAdded,
}: {
  accessToken: string | null;
  onNewToken: (t: string) => void;
  onAdded: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);

  const priceMinor = parseRupeesToMinor(price);
  const valid = name.trim().length > 0 && priceMinor !== null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !valid) return;
    setBusy(true);
    try {
      await createProduct(accessToken, onNewToken, {
        name: name.trim(),
        priceMinor: priceMinor!,
      });
      setName('');
      setPrice('');
      onAdded();
    } catch (err) {
      toast({
        title: 'Could not add the item',
        description: err instanceof ApiRequestError ? err.message : undefined,
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
      <label className="min-w-40 flex-1">
        <span className="text-label mb-1.5 block">Item name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </label>
      <label className="w-28">
        <span className="text-label mb-1.5 block">Price (₹)</span>
        <Input
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="120.00"
        />
      </label>
      <Button type="submit" variant="secondary" disabled={!valid || busy}>
        Add
      </Button>
    </form>
  );
}
