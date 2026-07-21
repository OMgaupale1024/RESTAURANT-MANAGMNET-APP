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
  Keyboard,
  Minus,
  Plus,
  Printer,
  ScanBarcode,
  Search,
  SearchX,
  ShoppingCart,
  Smartphone,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import Link from 'next/link';
import {
  ApiRequestError,
  createOrder,
  getCustomer,
  getRestaurantProfile,
  listCategories,
  listProducts,
  type Category,
  type Order,
  type Product,
  type RestaurantProfile,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatMinor } from '@/lib/money';
import { BillReceipt, usePrintArea } from '@/lib/receipt';
import { useCountUp } from '@/lib/use-count-up';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { CustomerPicker, type PosCustomer } from './customer-picker';

type CartLine = { product: Product; quantity: number };
type LastAction = { label: string; productId: string; at: number };

const METHODS = [
  { key: 'CASH', label: 'Cash', icon: Banknote },
  { key: 'UPI', label: 'UPI', icon: Smartphone },
  { key: 'CARD', label: 'Card', icon: CreditCard },
] as const;
type MethodKey = (typeof METHODS)[number]['key'];

const SHORTCUTS: Array<{ keys: string[]; does: string }> = [
  { keys: ['/', 'F2'], does: 'Focus search' },
  { keys: ['Enter'], does: 'Add the top search match' },
  { keys: ['Esc'], does: 'Clear search / close dialogs' },
  { keys: ['Ctrl', 'Enter'], does: 'Charge the order' },
  { keys: ['Ctrl', 'Backspace'], does: 'Clear the cart' },
  { keys: ['Alt', '1 · 2 · 3'], does: 'Cash / UPI / Card' },
  { keys: ['?'], does: 'Open this help' },
];

/** How long a removed cart line takes to collapse before it leaves the state. */
const LINE_OUT_MS = 160;

export function PosClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [products, setProducts] = useState<Product[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);

  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string>('all');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customer, setCustomerState] = useState<PosCustomer | null>(null);
  const [visits, setVisits] = useState<number | null>(null);
  const [coupon, setCoupon] = useState('');
  const [note, setNote] = useState('');
  const [method, setMethod] = useState<MethodKey>('CASH');
  const [placing, setPlacing] = useState(false);
  const [success, setSuccess] = useState<Order | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [lastAction, setLastAction] = useState<LastAction | null>(null);
  const [leaving, setLeaving] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [profile, setProfile] = useState<RestaurantProfile | null>(null);
  const { printNode, portal: printPortal } = usePrintArea();

  // Business profile for the bill header. Loaded once; failing only greys
  // the Print button.
  useEffect(() => {
    if (!accessToken) return;
    getRestaurantProfile(accessToken, (t) => setAccessToken(t))
      .then(setProfile)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const searchRef = useRef<HTMLInputElement>(null);
  // Lines mid-collapse: id → removal timer. Lets a re-add cancel the removal.
  const leavingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
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
  }, [accessToken, onNewToken, toast]);

  const setCustomer = (c: PosCustomer | null) => {
    setVisits(null);
    setCustomerState(c);
  };

  // Loyalty is read from the existing customer stats — there is no loyalty
  // program in the API; a failed lookup just means no badge.
  useEffect(() => {
    if (!accessToken || !customer) return;
    let cancelled = false;
    getCustomer(accessToken, onNewToken, customer.id)
      .then((d) => {
        if (!cancelled) setVisits(d.stats.visits);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, customer]);

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

  function unleave(id: string) {
    const t = leavingTimers.current.get(id);
    if (!t) return;
    clearTimeout(t);
    leavingTimers.current.delete(id);
    setLeaving((s) => s.filter((x) => x !== id));
  }

  function add(product: Product) {
    unleave(product.id);
    setLastAction({ label: `Added ${product.name}`, productId: product.id, at: Date.now() });
    setCart((c) => {
      if (c.length === 0) idemKey.current = crypto.randomUUID();
      const found = c.find((l) => l.product.id === product.id);
      return found
        ? c.map((l) =>
            l.product.id === product.id ? { ...l, quantity: l.quantity + 1 } : l,
          )
        : [...c, { product, quantity: 1 }];
    });
  }

  function removeLine(id: string) {
    const line = cart.find((l) => l.product.id === id);
    if (!line || leavingTimers.current.has(id)) return;
    setLastAction({ label: `Removed ${line.product.name}`, productId: id, at: Date.now() });
    setLeaving((s) => [...s, id]);
    // The line collapses first, then leaves the state — an instant removal
    // makes the rest of the cart jump.
    leavingTimers.current.set(
      id,
      setTimeout(() => {
        leavingTimers.current.delete(id);
        setLeaving((s) => s.filter((x) => x !== id));
        setCart((c) => c.filter((l) => l.product.id !== id));
      }, LINE_OUT_MS),
    );
  }

  function changeQty(id: string, delta: number) {
    const line = cart.find((l) => l.product.id === id);
    if (!line || leavingTimers.current.has(id)) return;
    if (line.quantity + delta <= 0) {
      removeLine(id);
      return;
    }
    setLastAction({
      label: `${delta > 0 ? 'Added' : 'Removed one'} ${line.product.name}`,
      productId: id,
      at: Date.now(),
    });
    setCart((c) =>
      c.map((l) => (l.product.id === id ? { ...l, quantity: l.quantity + delta } : l)),
    );
  }

  function clearCart() {
    for (const t of leavingTimers.current.values()) clearTimeout(t);
    leavingTimers.current.clear();
    setLeaving([]);
    setCart([]);
    setCoupon('');
    setNote('');
    setCustomer(null);
    setLastAction(null);
    idemKey.current = null;
  }

  // Lines mid-collapse are already "removed" as far as money is concerned:
  // totals and Charge must not include a line the cashier just deleted.
  const activeCart = leaving.length
    ? cart.filter((l) => !leaving.includes(l.product.id))
    : cart;

  async function charge() {
    if (!accessToken || activeCart.length === 0 || placing) return;
    setPlacing(true);
    try {
      const order = await createOrder(accessToken, onNewToken, {
        items: activeCart.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
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

  // One document-level handler for every POS shortcut, re-bound each render
  // so it always closes over fresh state — cheaper than a ref dance and
  // imperceptible next to a keypress.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Open dialogs (help, confirm, mobile cart sheet) own the keyboard.
      if (document.querySelector('dialog[open]')) return;
      const target = e.target as HTMLElement;
      const field = target.closest?.('input, textarea, select, [contenteditable]');

      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        void charge();
        return;
      }
      if (e.ctrlKey && e.key === 'Backspace') {
        // In a non-empty field, Ctrl+Backspace stays word-delete.
        if (field instanceof HTMLInputElement && field.value) return;
        e.preventDefault();
        if (activeCart.length > 0) setConfirmClear(true);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const i = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
        if (i !== -1) {
          e.preventDefault();
          setMethod(METHODS[i].key);
          return;
        }
      }
      if (e.key === 'F2') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        // The search input clears itself via its own handler when focused.
        if (!field && q) setQ('');
        return;
      }
      if (field) return;
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === '?') {
        e.preventDefault();
        setHelpOpen(true);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  /**
   * Displayed only. The server recomputes every figure from its own prices —
   * these numbers are a preview for the cashier, never an input to the order.
   */
  const subtotal = activeCart.reduce((s, l) => s + l.product.priceMinor * l.quantity, 0);
  const tax = activeCart.reduce(
    (s, l) =>
      s + Math.round((l.product.priceMinor * l.quantity * l.product.taxRateBp) / 10_000),
    0,
  );
  const itemCount = activeCart.reduce((s, l) => s + l.quantity, 0);
  const mobileTotal = useCountUp(subtotal + tax, 300);

  const cartPanel = (
    <CartPanel
      cart={cart}
      leaving={leaving}
      itemCount={itemCount}
      lastAction={lastAction}
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
      onPrintBill={
        profile
          ? (o: Order) => printNode(<BillReceipt order={o} profile={profile} />)
          : undefined
      }
      charge={() => void charge()}
      changeQty={changeQty}
      removeLine={removeLine}
      askClear={() => setConfirmClear(true)}
      customerSlot={
        <CustomerPicker
          accessToken={accessToken}
          onNewToken={onNewToken}
          customer={customer}
          visits={visits}
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
          <div className="flex max-w-md items-center gap-1.5">
            <div className="relative min-w-0 flex-1">
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
            <Button
              variant="ghost"
              size="sm"
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              onClick={() => setHelpOpen(true)}
              className="h-9 shrink-0 text-ink-3"
            >
              <Keyboard aria-hidden className="size-4" />
            </Button>
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
                body="Set up your menu first — items appear here instantly and you can start selling."
                action={
                  <Link
                    href="/dashboard/menu"
                    className="inline-flex h-9 items-center rounded-lg bg-brand px-3.5 text-sm font-medium text-brand-ink"
                  >
                    Set up the menu →
                  </Link>
                }
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
                          <>
                            {/* Keyed by qty so every add re-runs the pulse. */}
                            <span
                              key={`flash-${qty}`}
                              aria-hidden
                              className="pointer-events-none absolute inset-0 rounded-xl"
                              style={{ animation: 'flash 360ms var(--ease-out-quart) both' }}
                            />
                            <span
                              key={qty}
                              aria-label={`${qty} in cart`}
                              className="absolute top-2 right-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1 text-[11px] font-semibold text-brand-ink tabular-nums"
                              style={{ animation: 'pop 240ms var(--ease-spring) both' }}
                            >
                              {qty}
                            </span>
                          </>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-6 text-[13px] text-ink-3">
                Menu changes live in{' '}
                <Link
                  href="/dashboard/menu"
                  className="font-medium text-ink-2 underline-offset-4 hover:underline"
                >
                  Menu
                </Link>
                .
              </p>
            </>
          )}
        </div>

        {/* Mobile cart bar */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line bg-surface p-3 lg:hidden">
          <p className="text-sm">
            <span className="font-medium tabular-nums">{itemCount}</span>{' '}
            <span className="text-ink-2">{itemCount === 1 ? 'item' : 'items'}</span>
            <span className="ml-2 font-semibold tabular-nums">
              {formatMinor(mobileTotal)}
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

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => {
          clearCart();
          setConfirmClear(false);
        }}
        title="Clear this order?"
        body="Removes every item, the customer and the note from the current order."
        confirmLabel="Clear order"
      />

      {printPortal}

      <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard shortcuts">
        <dl className="space-y-2.5">
          {SHORTCUTS.map((s) => (
            <div key={s.does} className="flex items-center justify-between gap-6">
              <dt className="flex shrink-0 items-center gap-1">
                {s.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dt>
              <dd className="text-right text-[13px] text-ink-2">{s.does}</dd>
            </div>
          ))}
        </dl>
      </Modal>
    </div>
  );
}

function CartPanel({
  cart,
  leaving,
  itemCount,
  lastAction,
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
  onPrintBill,
  charge,
  changeQty,
  removeLine,
  askClear,
  customerSlot,
}: {
  cart: CartLine[];
  leaving: string[];
  itemCount: number;
  lastAction: LastAction | null;
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
  /** Absent until the business profile has loaded. */
  onPrintBill?: (order: Order) => void;
  charge: () => void;
  changeQty: (id: string, delta: number) => void;
  removeLine: (id: string) => void;
  askClear: () => void;
  customerSlot: React.ReactNode;
}) {
  const total = useCountUp(subtotal + tax, 300);

  if (success) {
    return (
      <div
        key={success.id}
        className="flex flex-1 animate-scale-in flex-col items-center justify-center gap-4 p-6 text-center"
      >
        <CheckCircle2
          aria-hidden
          className="size-12 text-success-text"
          style={{ animation: 'pop 320ms var(--ease-spring) both' }}
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
        {/* The panel is rendered twice (rail + sheet); focus() on the hidden
            copy is a no-op, so autoFocus lands on the visible one. */}
        <div className="flex gap-2">
          <Button
            variant="secondary"
            disabled={!onPrintBill}
            title={onPrintBill ? 'Print the customer bill' : 'Loading business profile…'}
            onClick={() => onPrintBill?.(success)}
          >
            <Printer aria-hidden className="size-4" />
            Print bill
          </Button>
          <Button variant="primary" onClick={onNewOrder} autoFocus>
            New order
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">
            Current order
            {itemCount > 0 && (
              <span className="ml-2 text-[12px] font-normal text-ink-3 tabular-nums">
                {itemCount} item{itemCount === 1 ? '' : 's'} · {formatMinor(total)}
              </span>
            )}
          </h2>
          {lastAction && (
            <p
              key={lastAction.at}
              className="mt-0.5 animate-fade-up truncate text-[11px] text-ink-3"
            >
              {lastAction.label} · <TimeAgo at={lastAction.at} />
            </p>
          )}
        </div>
        {cart.length > 0 && (
          <Button variant="ghost" size="sm" onClick={askClear} title="Ctrl+Backspace">
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
            action={
              <div className="space-y-2 text-[12px] text-ink-3">
                <p>
                  Press <Kbd>/</Kbd> to search products
                </p>
                <p className="flex items-center justify-center gap-1.5">
                  <ScanBarcode aria-hidden className="size-3.5" />
                  Scan barcode
                  <Badge>Coming soon</Badge>
                </p>
              </div>
            }
          />
        </div>
      ) : (
        <>
          <ul className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto">
            {cart.map((l) => {
              const isLeaving = leaving.includes(l.product.id);
              const flashAt =
                lastAction && lastAction.productId === l.product.id ? lastAction.at : 0;
              return (
                <li
                  key={l.product.id}
                  className={cn(
                    'animate-fade-up overflow-hidden rounded-lg',
                    isLeaving && 'pointer-events-none',
                  )}
                  style={
                    isLeaving
                      ? { animation: `cart-line-out ${LINE_OUT_MS}ms var(--ease-swift) forwards` }
                      : undefined
                  }
                >
                  {/* Keyed by the action timestamp so every touch re-flashes. */}
                  <div
                    key={flashAt}
                    className="rounded-lg px-1 py-2"
                    style={
                      flashAt && !isLeaving
                        ? { animation: 'flash 480ms var(--ease-out-quart) both' }
                        : undefined
                    }
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate text-[13px] font-medium">
                        {l.product.name}
                      </span>
                      <span
                        key={l.product.priceMinor * l.quantity}
                        className="shrink-0 text-[13px] font-medium tabular-nums"
                        style={{ animation: 'scale-in 140ms var(--ease-out-quart)' }}
                      >
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
                        style={{ animation: 'pop 200ms var(--ease-spring)' }}
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
                  </div>
                </li>
              );
            })}
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
              <dd className="tabular-nums">{formatMinor(total)}</dd>
            </div>
          </dl>

          <div className="mt-3 grid grid-cols-3 gap-2" aria-label="Payment method">
            {METHODS.map((m, i) => (
              <button
                key={m.key}
                type="button"
                aria-pressed={method === m.key}
                title={`Alt+${i + 1}`}
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
            title="Ctrl+Enter"
            className="mt-2 h-[52px] w-full text-[15px]"
          >
            {placing ? 'Charging…' : `Charge ${formatMinor(total)}`}
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

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-md border border-line-2 bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
      {children}
    </kbd>
  );
}

/** Ticking relative timestamp for the cart's "last action" line. */
function TimeAgo({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.floor((now - at) / 1000));
  return <>{s < 2 ? 'just now' : s < 60 ? `${s} sec ago` : `${Math.floor(s / 60)} min ago`}</>;
}

