'use client';

import { usePathname, useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ChefHat,
  FileText,
  History,
  Megaphone,
  Package,
  Receipt,
  Search,
  SearchX,
  Settings,
  Store,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react';
import {
  listCoupons,
  listCustomers,
  listIngredients,
  listOrders,
  listProducts,
  listStaff,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatMinor } from '@/lib/money';
import { allowedHrefs, NAV_GROUPS } from './nav';

type Result = {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  href: string;
  /** Instead of navigating, put this text in the search box (recent searches). */
  fill?: string;
};

type Group = { label: string; results: Result[] };

/**
 * Entity caches, fetched once per palette-open then filtered client-side.
 * Customers use the server's `?q=` search (phone-aware); the rest are small
 * tenant-scoped lists. Failed fetches (e.g. a 403 for a role) become empty
 * groups — the palette never errors, it just shows less.
 */
type EntityCache = {
  orders: Awaited<ReturnType<typeof listOrders>>;
  products: Awaited<ReturnType<typeof listProducts>>;
  ingredients: Awaited<ReturnType<typeof listIngredients>>;
  coupons: Awaited<ReturnType<typeof listCoupons>>;
  staff: Awaited<ReturnType<typeof listStaff>>;
};

const SETTINGS_ITEM = {
  label: 'Settings',
  href: '/dashboard/settings',
  icon: Settings,
};

type PageItem = { label: string; href: string; icon: LucideIcon };

const ALL_PAGES: PageItem[] = [
  ...NAV_GROUPS.flatMap((g) => g.items),
  SETTINGS_ITEM,
];

/** Verb-first shortcuts to existing routes — no new capabilities, just speed. */
const QUICK_ACTIONS: PageItem[] = [
  { label: 'Take an order', href: '/dashboard/pos', icon: Store },
  { label: 'Open the kitchen board', href: '/dashboard/kitchen', icon: ChefHat },
  { label: "Run today's report", href: '/dashboard/reports', icon: FileText },
  { label: 'Create a coupon', href: '/dashboard/marketing', icon: Megaphone },
  { label: 'Invite staff', href: '/dashboard/staff', icon: UserCog },
];

function readRecents(): { pages: string[]; searches: string[] } {
  try {
    return {
      pages: JSON.parse(localStorage.getItem('oraos.recent-pages') ?? '[]') as string[],
      searches: JSON.parse(
        localStorage.getItem('oraos.recent-searches') ?? '[]',
      ) as string[],
    };
  } catch {
    return { pages: [], searches: [] };
  }
}

function saveRecentSearch(q: string) {
  try {
    const raw = JSON.parse(
      localStorage.getItem('oraos.recent-searches') ?? '[]',
    ) as string[];
    localStorage.setItem(
      'oraos.recent-searches',
      JSON.stringify([q, ...raw.filter((s) => s !== q)].slice(0, 5)),
    );
  } catch {
    // localStorage unavailable — recents just don't persist.
  }
}

export function CommandPalette({
  open,
  onClose,
  roleKey,
}: {
  open: boolean;
  onClose: () => void;
  roleKey: string;
}) {
  const router = useRouter();
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback(
    (t: string) => setAccessToken(t),
    [setAccessToken],
  );

  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cacheRef = useRef<EntityCache | null>(null);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [entityGroups, setEntityGroups] = useState<Group[]>([]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      cacheRef.current = null;
      setQuery('');
      setEntityGroups([]);
      setSelected(0);
      d.showModal();
      inputRef.current?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  const pathname = usePathname();
  const allowed = useMemo(() => allowedHrefs(roleKey), [roleKey]);
  // Re-read on each open so picks from the last session show up.
  const recents = useMemo(
    () => (open ? readRecents() : { pages: [], searches: [] }),
    [open],
  );

  // Static groups: empty query is the launcher (recents, actions, pages);
  // a query filters pages and actions by label.
  const staticGroups = useMemo<Group[]>(() => {
    const q = query.trim().toLowerCase();
    const visible = (i: PageItem) =>
      !allowed || allowed.has(i.href) || i.href === SETTINGS_ITEM.href;
    const toResult = (i: PageItem, hint: string, idPrefix = 'page'): Result => ({
      id: `${idPrefix}:${i.href}:${i.label}`,
      label: i.label,
      hint,
      icon: i.icon,
      href: i.href,
    });

    if (!q) {
      const recentPages = recents.pages
        .filter((h) => h !== pathname)
        .map((h) => ALL_PAGES.find((p) => p.href === h))
        .filter((p): p is PageItem => !!p && visible(p))
        .slice(0, 4)
        .map((p) => toResult(p, 'Recent', 'recent'));
      const recentSearches: Result[] = recents.searches.slice(0, 3).map((s) => ({
        id: `search:${s}`,
        label: s,
        hint: 'Search again',
        icon: History,
        href: '',
        fill: s,
      }));
      return [
        { label: 'Recent', results: [...recentPages, ...recentSearches] },
        {
          label: 'Quick actions',
          results: QUICK_ACTIONS.filter(visible).map((a) =>
            toResult(a, 'Action', 'action'),
          ),
        },
        {
          label: 'Pages',
          results: ALL_PAGES.filter(visible).map((p) => toResult(p, 'Page')),
        },
      ];
    }

    return [
      {
        label: 'Pages',
        results: ALL_PAGES.filter(visible)
          .filter((i) => i.label.toLowerCase().includes(q))
          .map((p) => toResult(p, 'Page')),
      },
      {
        label: 'Quick actions',
        results: QUICK_ACTIONS.filter(visible)
          .filter((i) => i.label.toLowerCase().includes(q))
          .map((a) => toResult(a, 'Action', 'action')),
      },
    ];
  }, [query, allowed, recents, pathname]);

  // Entity search, debounced. Role-gates which entity kinds are queried at
  // all so the palette matches the sidebar (server enforces regardless).
  useEffect(() => {
    if (!open || !accessToken) return;
    const q = query.trim().toLowerCase();

    const key = roleKey.toUpperCase();
    const canOperate = true; // every role with palette access reads orders
    const canGrow = key !== 'KITCHEN';
    const canManage = key !== 'KITCHEN' && key !== 'CASHIER';

    const timer = setTimeout(async () => {
      if (q.length < 2) {
        setEntityGroups([]);
        return;
      }
      const none = [] as never[];
      let cache = cacheRef.current;
      if (!cache) {
        const [orders, products, ingredients, coupons, staff] = await Promise.all([
          canOperate ? listOrders(accessToken, onNewToken).catch(() => none) : none,
          canGrow ? listProducts(accessToken, onNewToken).catch(() => none) : none,
          canManage ? listIngredients(accessToken, onNewToken).catch(() => none) : none,
          canManage ? listCoupons(accessToken, onNewToken).catch(() => none) : none,
          canManage ? listStaff(accessToken, onNewToken).catch(() => none) : none,
        ]);
        cache = { orders, products, ingredients, coupons, staff };
        cacheRef.current = cache;
      }

      const customers = canGrow
        ? await listCustomers(accessToken, onNewToken, query.trim()).catch(() => none)
        : none;

      const groups: Group[] = [
        {
          label: 'Orders',
          results: cache.orders
            .filter((o) => String(o.orderNumber).includes(q.replace('#', '')))
            .slice(0, 5)
            .map((o) => ({
              id: `order:${o.id}`,
              label: `Order #${o.orderNumber}`,
              hint: `${o.status} · ${formatMinor(o.totalMinor)}`,
              icon: Receipt,
              href: '/dashboard/orders',
            })),
        },
        {
          label: 'Customers',
          results: customers.slice(0, 5).map((c) => ({
            id: `customer:${c.id}`,
            label: c.name,
            hint: c.phone,
            icon: Users,
            href: '/dashboard/customers',
          })),
        },
        {
          label: 'Products',
          results: cache.products
            .filter((p) => p.name.toLowerCase().includes(q))
            .slice(0, 5)
            .map((p) => ({
              id: `product:${p.id}`,
              label: p.name,
              hint: formatMinor(p.priceMinor),
              icon: Store,
              href: '/dashboard/pos',
            })),
        },
        {
          label: 'Inventory',
          results: cache.ingredients
            .filter((i) => i.name.toLowerCase().includes(q))
            .slice(0, 5)
            .map((i) => ({
              id: `ingredient:${i.id}`,
              label: i.name,
              hint: i.isLow ? 'Low stock' : undefined,
              icon: Package,
              href: '/dashboard/inventory',
            })),
        },
        {
          label: 'Coupons',
          results: cache.coupons
            .filter((c) => c.code.toLowerCase().includes(q))
            .slice(0, 5)
            .map((c) => ({
              id: `coupon:${c.id}`,
              label: c.code,
              hint: c.isActive ? 'Active' : 'Inactive',
              icon: Megaphone,
              href: '/dashboard/marketing',
            })),
        },
        {
          label: 'Staff',
          results: cache.staff
            .filter(
              (s) =>
                s.user.name.toLowerCase().includes(q) ||
                s.user.email.toLowerCase().includes(q),
            )
            .slice(0, 5)
            .map((s) => ({
              id: `staff:${s.id}`,
              label: s.user.name,
              hint: s.role.name,
              icon: UserCog,
              href: '/dashboard/staff',
            })),
        },
      ].filter((g) => g.results.length > 0);

      setEntityGroups(groups);
    }, 200);

    return () => clearTimeout(timer);
  }, [open, query, accessToken, onNewToken, roleKey]);

  const groups = useMemo(
    () =>
      [...staticGroups, ...entityGroups].filter((g) => g.results.length > 0),
    [staticGroups, entityGroups],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.results), [groups]);
  const clamped = Math.min(selected, Math.max(0, flat.length - 1));

  function go(item: Result) {
    // Recent-search rows refill the box instead of navigating. Rows never
    // steal focus (see PaletteRow's onMouseDown), so the input keeps it.
    if (item.fill !== undefined) {
      setQuery(item.fill);
      setSelected(0);
      return;
    }
    const q = query.trim();
    if (q) saveRecentSearch(q);
    onClose();
    router.push(item.href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => (s + 1) % Math.max(1, flat.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => (s - 1 + flat.length) % Math.max(1, flat.length));
    } else if (e.key === 'Enter' && flat[clamped]) {
      e.preventDefault();
      go(flat[clamped]);
    }
  }

  let index = -1;

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      onKeyDown={onKeyDown}
      className={cn(
        'mx-auto mt-[12vh] mb-auto w-full max-w-[560px] overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink',
        'shadow-[0_16px_48px_rgb(0_0_0/0.16)] backdrop:bg-black/40 backdrop:backdrop-blur-[4px]',
        'dialog-anim dialog-pop',
      )}
    >
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Search aria-hidden className="size-4 shrink-0 text-ink-3" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          placeholder="Search pages, orders, customers…"
          aria-label="Search"
          className="h-12 w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
        />
        <Kbd>esc</Kbd>
      </div>

      <div className="max-h-[320px] overflow-y-auto p-2">
        {flat.length === 0 ? (
          <div className="px-3 py-10 text-center">
            <SearchX aria-hidden className="mx-auto size-5 text-ink-3" />
            <p className="mt-2 text-sm">No results for “{query.trim()}”</p>
            <p className="mt-1 text-[12px] text-ink-3">
              Try a different term — orders match by number, customers by name
              or phone.
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label}>
              <p className="text-label px-3 pt-2 pb-1">{group.label}</p>
              {group.results.map((item) => {
                index += 1;
                const i = index;
                return (
                  <PaletteRow
                    key={item.id}
                    item={item}
                    query={query.trim()}
                    active={i === clamped}
                    onHover={() => setSelected(i)}
                    onPick={() => go(item)}
                  />
                );
              })}
            </div>
          ))
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-[11px] text-ink-3">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> open
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd> toggle
        </span>
      </div>
    </dialog>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="grid h-[18px] min-w-[18px] place-items-center rounded border border-line bg-surface-2 px-1 font-mono text-[10px] text-ink-2">
      {children}
    </kbd>
  );
}

/** Mark the first case-insensitive match of the query inside a result label. */
function Highlight({ text, query }: { text: string; query: string }) {
  const i = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-[3px] bg-brand/35 text-inherit">
        {text.slice(i, i + query.length)}
      </mark>
      {text.slice(i + query.length)}
    </>
  );
}

function PaletteRow({
  item,
  query,
  active,
  onHover,
  onPick,
}: {
  item: Result;
  query: string;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}): ReactNode {
  const rowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <button
      ref={rowRef}
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={onHover}
      onClick={onPick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors duration-120',
        active ? 'bg-surface-2 text-ink' : 'text-ink-2',
      )}
    >
      <item.icon aria-hidden className="size-4 shrink-0 text-ink-3" />
      <span className="truncate">
        <Highlight text={item.label} query={query} />
      </span>
      {item.hint && (
        <span className="ml-auto shrink-0 text-[12px] text-ink-3 tabular-nums">
          {item.hint}
        </span>
      )}
    </button>
  );
}
