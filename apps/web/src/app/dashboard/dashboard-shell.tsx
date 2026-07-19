'use client';

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Check,
  ChevronsUpDown,
  LogOut,
  Menu,
  PanelLeft,
  Search,
  Settings,
} from 'lucide-react';
import {
  getMe,
  logout as apiLogout,
  selectRestaurant,
  type MeResponse,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { ToastProvider } from '@/components/ui/toast';
import { CommandPalette } from './command-palette';
import { homeForRole, SidebarNav } from './nav';

/** POS and KDS need the pixels: sidebar drops to the icon rail, main goes edge-to-edge. */
const FULL_BLEED = new Set(['/dashboard/pos', '/dashboard/kitchen']);

/**
 * Sidebar collapse preference as a tiny external store so it can hydrate from
 * localStorage without a set-state-in-effect (server snapshot: expanded).
 */
const collapseListeners = new Set<() => void>();
const collapseStore = {
  subscribe(l: () => void) {
    collapseListeners.add(l);
    return () => collapseListeners.delete(l);
  },
  get: () => localStorage.getItem('oraos.sidebar') === 'collapsed',
  set(v: boolean) {
    localStorage.setItem('oraos.sidebar', v ? 'collapsed' : 'expanded');
    collapseListeners.forEach((l) => l());
  },
};

/** Best-effort read of the token's restaurant scope. UX only — on any doubt, memberships[0]. */
function restaurantIdFromToken(token: string): string | null {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64)) as Record<string, unknown>;
    return typeof payload.restaurantId === 'string' ? payload.restaurantId : null;
  } catch {
    return null;
  }
}

/**
 * Client-side route guard plus the frame around every dashboard page.
 *
 * Worth being explicit: this guard is a UX affordance, NOT a security control.
 * It decides what to render, and a determined user can bypass it with DevTools.
 * The real boundary is server-side — every API call needs a valid JWT, and RLS
 * scopes every row to the tenant in that token. Bypassing this guard reveals an
 * empty shell that can fetch nothing.
 */
export function DashboardShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { accessToken, status, setAccessToken, clear } = useAuth();

  const [me, setMe] = useState<MeResponse | null>(null);
  const collapsed = useSyncExternalStore(
    collapseStore.subscribe,
    collapseStore.get,
    () => false,
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);

  useEffect(() => {
    if (status !== 'authenticated' || !accessToken) return;
    getMe(accessToken)
      .then((data) => {
        // Authenticated but no restaurant: setup is the only thing they can do.
        if (data.memberships.length === 0) router.replace('/setup');
        else setMe(data);
      })
      .catch(() => clear());
  }, [status, accessToken, router, clear]);

  // Recently-visited trail for the command palette's Recent group.
  useEffect(() => {
    if (!pathname.startsWith('/dashboard')) return;
    try {
      const raw = JSON.parse(
        localStorage.getItem('oraos.recent-pages') ?? '[]',
      ) as string[];
      const next = [pathname, ...raw.filter((p) => p !== pathname)].slice(0, 6);
      localStorage.setItem('oraos.recent-pages', JSON.stringify(next));
    } catch {
      // localStorage unavailable — recents just stay empty.
    }
  }, [pathname]);

  // Ctrl/Cmd+K toggles the command palette from anywhere in the dashboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const tokenId = accessToken ? restaurantIdFromToken(accessToken) : null;
  const current =
    me?.memberships.find((m) => m.restaurant.id === tokenId) ??
    (me?.memberships.length === 1 ? me?.memberships[0] : undefined);
  const roleKey = current?.role.key ?? '';

  // Operational roles land on their tool, not an analytics home they can't read.
  useEffect(() => {
    if (!current) return;
    const home = homeForRole(roleKey);
    if (pathname === '/dashboard' && home !== '/dashboard') router.replace(home);
  }, [current, roleKey, pathname, router]);

  async function onSignOut() {
    // Revoke the refresh token server-side before dropping local state.
    // Clearing memory alone would leave a working session in the cookie.
    await apiLogout().catch(() => undefined);
    clear();
    router.replace('/login');
  }

  async function onSwitchRestaurant(restaurantId: string) {
    setSwitcherOpen(false);
    if (!accessToken || restaurantId === current?.restaurant.id) return;
    // New token is scoped to the chosen restaurant; every data effect keys on
    // accessToken, so the whole dashboard reloads itself against the new tenant.
    const { accessToken: fresh } = await selectRestaurant(accessToken, restaurantId);
    setAccessToken(fresh);
    router.replace(homeForRole(roleKey));
  }

  const toggleCollapsed = () => collapseStore.set(!collapsed);

  if (status === 'loading' || !me) {
    return (
      <div className="flex min-h-dvh">
        <div className="hidden w-60 shrink-0 border-r border-line p-4 md:block">
          <Skeleton className="h-6 w-28" />
          <div className="mt-8 space-y-2">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        </div>
        <div className="flex-1 p-8">
          <Skeleton className="h-7 w-48" />
          <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Full-screen restaurant picker (DESIGN.md §6)
  if (!current && me.memberships.length > 1) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center p-6 bg-page">
        <div className="w-full max-w-md animate-fade-up">
          <div className="mb-8 text-center">
            <span className="text-xl font-semibold tracking-tight">OraOS</span>
            <h1 className="mt-4 text-2xl font-semibold tracking-tight">
              Select a workspace
            </h1>
          </div>
          <div className="space-y-3">
            {me.memberships.map((m, i) => (
              <button
                key={m.id}
                onClick={() => onSwitchRestaurant(m.restaurant.id)}
                className="flex w-full items-center justify-between rounded-xl border border-line bg-surface p-4 text-left transition-colors duration-120 hover:border-line-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                style={{ animationDelay: `${i * 40}ms` }}
              >
                <div className="min-w-0 flex-1 pr-4">
                  <p className="truncate font-medium">{m.restaurant.name}</p>
                  <p className="truncate text-sm text-ink-2">Join as {m.role.name}</p>
                </div>
                <Badge className="shrink-0">{m.role.name}</Badge>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!current) return null;

  const fullBleed = FULL_BLEED.has(pathname);
  const railOnly = collapsed || fullBleed;
  const multiRestaurant = me.memberships.length > 1;

  const renderSidebar = (railOnly: boolean) => (
    <>
      {/* Wordmark + restaurant switcher */}
      <div className={cn('relative px-3 pt-4 pb-2', railOnly && 'px-2')}>
        <button
          type="button"
          disabled={!multiRestaurant}
          onClick={() => setSwitcherOpen((o) => !o)}
          aria-expanded={switcherOpen}
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-120',
            multiRestaurant && 'hover:bg-surface-2',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current',
          )}
        >
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-brand text-[13px] font-bold text-brand-ink">
            O
          </span>
          {!railOnly && (
            <>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold tracking-tight">
                  OraOS
                </span>
                <span className="block truncate text-[12px] text-ink-2">
                  {current.restaurant.name}
                </span>
              </span>
              {multiRestaurant && (
                <ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-ink-3" />
              )}
            </>
          )}
        </button>

        {switcherOpen && multiRestaurant && (
          <>
            <button
              type="button"
              aria-label="Close switcher"
              className="fixed inset-0 z-20 cursor-default"
              onClick={() => setSwitcherOpen(false)}
            />
            <div className="absolute inset-x-3 z-30 mt-1 animate-scale-in rounded-xl border border-line bg-surface p-1 shadow-[0_4px_16px_rgb(0_0_0/0.08)]">
              {me.memberships.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onSwitchRestaurant(m.restaurant.id)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition-colors duration-120 hover:bg-surface-2"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'grid size-7 shrink-0 place-items-center rounded-md text-[12px] font-semibold',
                      m.id === current.id
                        ? 'bg-brand text-brand-ink'
                        : 'bg-surface-2 text-ink-2',
                    )}
                  >
                    {m.restaurant.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{m.restaurant.name}</span>
                    <Badge className="mt-0.5">{m.role.name}</Badge>
                  </span>
                  {m.id === current.id && (
                    <Check className="ml-auto size-4 shrink-0 text-ink-2" />
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Search / command palette */}
      <div className={cn('px-3 pb-1', railOnly && 'px-2')}>
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          title={railOnly ? 'Search (Ctrl K)' : undefined}
          className={cn(
            'flex h-8 w-full items-center gap-2.5 rounded-lg border border-line bg-surface px-3 text-sm text-ink-3 transition-colors duration-120 hover:border-line-2 hover:text-ink-2',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current',
            railOnly && 'justify-center border-transparent bg-transparent px-0 hover:bg-surface-2',
          )}
        >
          <Search aria-hidden className="size-4 shrink-0" />
          {!railOnly && (
            <>
              <span>Search…</span>
              <kbd className="ml-auto font-mono text-[11px]">Ctrl K</kbd>
            </>
          )}
        </button>
      </div>

      <SidebarNav
        roleKey={roleKey}
        collapsed={railOnly}
        onNavigate={() => setMobileNavOpen(false)}
      />

      {/* Bottom: settings, user, sign out, collapse */}
      <div className={cn('border-t border-line px-3 py-3', railOnly && 'px-2')}>
        <Link
          href="/dashboard/settings"
          onClick={() => setMobileNavOpen(false)}
          title={railOnly ? 'Settings' : undefined}
          className={cn(
            'flex h-8 items-center gap-2.5 rounded-lg px-3 text-sm text-ink-2 transition-colors duration-120 hover:bg-surface-2 hover:text-ink',
            railOnly && 'justify-center px-0',
          )}
        >
          <Settings aria-hidden className="size-4 shrink-0" />
          {!railOnly && <span>Settings</span>}
        </Link>
        <div
          className={cn(
            'mt-1 flex items-center gap-2 px-3',
            railOnly && 'justify-center px-0',
          )}
        >
          {!railOnly && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">{me.user.name}</span>
              <span className="block truncate text-[11px] text-ink-3">
                {current.role.name}
              </span>
            </span>
          )}
          <button
            type="button"
            onClick={onSignOut}
            title="Sign out"
            className="rounded-md p-1.5 text-ink-3 transition-colors duration-120 hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
          >
            <LogOut aria-hidden className="size-4" />
          </button>
        </div>
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'mt-1 hidden h-8 items-center gap-2.5 rounded-lg px-3 text-sm text-ink-3 transition-colors duration-120 hover:bg-surface-2 hover:text-ink md:flex',
            railOnly && 'w-full justify-center px-0',
          )}
        >
          <PanelLeft aria-hidden className="size-4 shrink-0" />
          {!railOnly && <span>Collapse</span>}
        </button>
      </div>
    </>
  );

  return (
    <ToastProvider>
      <div className="flex min-h-dvh">
        {/* Desktop sidebar */}
        <aside
          className={cn(
            'sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-line bg-page transition-[width] duration-180 ease-(--ease-swift) md:flex',
            railOnly ? 'w-16' : 'w-60',
          )}
        >
          {renderSidebar(railOnly)}
        </aside>

        {/* Mobile top bar + sheet nav */}
        <div className="fixed inset-x-0 top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-page px-4 md:hidden">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setMobileNavOpen(true)}
            className="-ml-1 rounded-md p-1.5 text-ink-2 hover:bg-surface-2"
          >
            <Menu className="size-5" />
          </button>
          <span className="text-sm font-semibold tracking-tight">OraOS</span>
          <span className="truncate text-[13px] text-ink-2">
            {current.restaurant.name}
          </span>
          <button
            type="button"
            aria-label="Search"
            onClick={() => setPaletteOpen(true)}
            className="ml-auto rounded-md p-1.5 text-ink-2 hover:bg-surface-2"
          >
            <Search className="size-4" />
          </button>
        </div>
        <Sheet
          open={mobileNavOpen}
          onClose={() => setMobileNavOpen(false)}
          side="left"
          title="OraOS"
          className="flex max-w-[300px] flex-col p-0 [&>div]:px-4 [&>div]:pt-4"
        >
          <div className="flex flex-1 flex-col pb-2">{renderSidebar(false)}</div>
        </Sheet>

        <main
          className={cn(
            'min-w-0 flex-1 pt-14 transition-transform duration-240 ease-(--ease-out-quart) md:pt-0',
            fullBleed ? '' : 'px-4 py-6 md:px-8',
            mobileNavOpen && 'scale-[0.985]',
          )}
        >
          <div
            key={pathname}
            className={cn('animate-fade-up', !fullBleed && 'mx-auto max-w-[1200px] md:mx-0')}
          >
            {children}
          </div>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        roleKey={roleKey}
      />
    </ToastProvider>
  );
}
