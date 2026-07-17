'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiRequestError,
  createOrder,
  createProduct,
  listProducts,
  type Order,
  type Product,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatMinor, parseRupeesToMinor } from '@/lib/money';
import { CustomerPicker } from './customer-picker';

type CartLine = { product: Product; quantity: number };

export function PosClient() {
  const { accessToken, setAccessToken } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [lastOrder, setLastOrder] = useState<Order | null>(null);
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(
    null,
  );

  // Passed to authedFetch so a silent refresh updates the session in place
  // rather than bouncing the cashier to /login mid-order.
  const onNewToken = useCallback(
    (t: string) => setAccessToken(t),
    [setAccessToken],
  );

  // Bumped to re-fetch the menu after adding an item, instead of calling a
  // setState-ing loader straight out of an effect.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    void (async () => {
      try {
        const items = await listProducts(accessToken, onNewToken);
        if (!cancelled) setProducts(items);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof ApiRequestError ? e.message : 'Could not load menu',
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, reloadKey]);

  function addToCart(product: Product) {
    setCart((c) => {
      const found = c.find((l) => l.product.id === product.id);
      return found
        ? c.map((l) =>
            l.product.id === product.id ? { ...l, quantity: l.quantity + 1 } : l,
          )
        : [...c, { product, quantity: 1 }];
    });
  }

  function changeQty(id: string, delta: number) {
    setCart((c) =>
      c
        .map((l) =>
          l.product.id === id ? { ...l, quantity: l.quantity + delta } : l,
        )
        .filter((l) => l.quantity > 0),
    );
  }

  /**
   * Displayed only. The server recomputes every figure from its own prices —
   * these numbers are a preview for the cashier, never an input to the order.
   */
  const subtotal = cart.reduce(
    (s, l) => s + l.product.priceMinor * l.quantity,
    0,
  );
  const tax = cart.reduce(
    (s, l) =>
      s + Math.round((l.product.priceMinor * l.quantity * l.product.taxRateBp) / 10_000),
    0,
  );

  async function placeOrder(paymentMethod: 'CASH' | 'UPI') {
    if (!accessToken || cart.length === 0) return;
    setError(null);
    setPlacing(true);
    try {
      const order = await createOrder(accessToken, onNewToken, {
        items: cart.map((l) => ({
          productId: l.product.id,
          quantity: l.quantity,
        })),
        // Optional by design: most orders are anonymous walk-ins, and the till
        // must never block on identifying someone.
        ...(customer ? { customerId: customer.id } : {}),
        paymentMethod,
        // Guards against a double-tapped Pay button on a laggy tablet: a
        // retry with the same key returns the original order, not a second
        // charge.
        idempotencyKey: crypto.randomUUID(),
      });
      setLastOrder(order);
      setCart([]);
      setCustomer(null);
    } catch (e) {
      setError(
        e instanceof ApiRequestError ? e.message : 'Could not place the order',
      );
    } finally {
      setPlacing(false);
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">POS</h1>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      )}

      {lastOrder && (
        <p
          role="status"
          className="mt-4 rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2 text-sm text-green-800 dark:text-green-300"
        >
          Order #{lastOrder.orderNumber} placed —{' '}
          {formatMinor(lastOrder.totalMinor)}
        </p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_20rem]">
        <section aria-labelledby="menu-heading">
          <h2 id="menu-heading" className="text-sm font-medium">
            Menu
          </h2>

          {products.length === 0 ? (
            <div className="mt-3 rounded-lg border border-black/10 p-6 dark:border-white/15">
              <p className="text-sm text-black/70 dark:text-white/70">
                No items yet. Add one to start selling.
              </p>
              <AddProduct
                accessToken={accessToken}
                onNewToken={onNewToken}
                onAdded={reload}
                setError={setError}
              />
            </div>
          ) : (
            <>
              <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {products.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => addToCart(p)}
                      className="w-full rounded-lg border border-black/10 p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
                    >
                      <span className="block text-sm font-medium">{p.name}</span>
                      <span className="mt-1 block text-sm text-black/60 dark:text-white/60">
                        {formatMinor(p.priceMinor)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <details className="mt-4">
                <summary className="cursor-pointer text-sm text-black/60 dark:text-white/60">
                  Add an item
                </summary>
                <AddProduct
                  accessToken={accessToken}
                  onNewToken={onNewToken}
                  onAdded={reload}
                  setError={setError}
                />
              </details>
            </>
          )}
        </section>

        <section
          aria-labelledby="cart-heading"
          className="rounded-lg border border-black/10 p-4 dark:border-white/15"
        >
          <h2 id="cart-heading" className="text-sm font-medium">
            Current order
          </h2>

          <CustomerPicker
            accessToken={accessToken}
            onNewToken={onNewToken}
            customer={customer}
            setCustomer={setCustomer}
            setError={setError}
          />

          {cart.length === 0 ? (
            <p className="mt-3 text-sm text-black/60 dark:text-white/60">
              Tap an item to add it.
            </p>
          ) : (
            <>
              <ul className="mt-3 space-y-2">
                {cart.map((l) => (
                  <li
                    key={l.product.id}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {l.product.name}
                    </span>
                    <span className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Remove one ${l.product.name}`}
                        onClick={() => changeQty(l.product.id, -1)}
                        className="h-7 w-7 rounded border border-black/20 focus-visible:outline-2 dark:border-white/25"
                      >
                        −
                      </button>
                      <span className="w-6 text-center text-sm tabular-nums">
                        {l.quantity}
                      </span>
                      <button
                        type="button"
                        aria-label={`Add one ${l.product.name}`}
                        onClick={() => changeQty(l.product.id, 1)}
                        className="h-7 w-7 rounded border border-black/20 focus-visible:outline-2 dark:border-white/25"
                      >
                        +
                      </button>
                    </span>
                    <span className="w-20 text-right text-sm tabular-nums">
                      {formatMinor(l.product.priceMinor * l.quantity)}
                    </span>
                  </li>
                ))}
              </ul>

              <dl className="mt-4 space-y-1 border-t border-black/10 pt-3 text-sm dark:border-white/15">
                <div className="flex justify-between">
                  <dt className="text-black/60 dark:text-white/60">Subtotal</dt>
                  <dd className="tabular-nums">{formatMinor(subtotal)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-black/60 dark:text-white/60">Tax</dt>
                  <dd className="tabular-nums">{formatMinor(tax)}</dd>
                </div>
                <div className="flex justify-between font-semibold">
                  <dt>Total</dt>
                  <dd className="tabular-nums">{formatMinor(subtotal + tax)}</dd>
                </div>
              </dl>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={placing}
                  onClick={() => placeOrder('CASH')}
                  className="rounded-md bg-brand px-3 py-3 text-sm font-semibold text-brand-ink focus-visible:outline-2 hover:brightness-95 disabled:opacity-60"
                >
                  {placing ? '…' : 'Cash'}
                </button>
                <button
                  type="button"
                  disabled={placing}
                  onClick={() => placeOrder('UPI')}
                  className="rounded-md border border-black/20 px-3 py-3 text-sm font-semibold focus-visible:outline-2 hover:bg-black/5 disabled:opacity-60 dark:border-white/25 dark:hover:bg-white/10"
                >
                  {placing ? '…' : 'UPI'}
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/** Minimal menu entry. Full menu management is not part of this step. */
function AddProduct({
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
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);

  const priceMinor = parseRupeesToMinor(price);
  const valid = name.trim().length > 0 && priceMinor !== null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !valid) return;
    setBusy(true);
    setError(null);
    try {
      await createProduct(accessToken, onNewToken, {
        name: name.trim(),
        priceMinor: priceMinor!,
      });
      setName('');
      setPrice('');
      onAdded();
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : 'Could not add the item',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
      <div className="flex-1">
        <label htmlFor="p-name" className="block text-xs font-medium">
          Item name
        </label>
        <input
          id="p-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          className="mt-1 w-full rounded-md border border-black/20 bg-transparent px-3 py-2 text-sm dark:border-white/25"
        />
      </div>
      <div className="w-28">
        <label htmlFor="p-price" className="block text-xs font-medium">
          Price (₹)
        </label>
        <input
          id="p-price"
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="120.00"
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
