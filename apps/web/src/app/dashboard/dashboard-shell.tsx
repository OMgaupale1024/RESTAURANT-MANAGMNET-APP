'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { getMe, logout as apiLogout, type MeResponse } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Nav } from './nav';

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
  const { accessToken, status, clear } = useAuth();
  const [me, setMe] = useState<MeResponse | null>(null);

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

  async function onSignOut() {
    // Revoke the refresh token server-side before dropping local state.
    // Clearing memory alone would leave a working session in the cookie.
    await apiLogout().catch(() => undefined);
    clear();
    router.replace('/login');
  }

  if (status === 'loading' || !me) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-black/60 dark:text-white/60">Loading…</p>
      </div>
    );
  }

  const current = me.memberships[0];

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-black/10 dark:border-white/15">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-baseline gap-3">
            <span className="font-semibold tracking-tight">OraOS</span>
            <span className="text-sm text-black/60 dark:text-white/60">
              {current.restaurant.name}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-black/60 sm:inline dark:text-white/60">
              {me.user.name} · {current.role.name}
            </span>
            <button
              type="button"
              onClick={onSignOut}
              className="rounded-md border border-black/20 px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current hover:bg-black/5 dark:border-white/25 dark:hover:bg-white/10"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 flex-col md:flex-row">
        <aside className="border-b border-black/10 md:w-48 md:border-r md:border-b-0 dark:border-white/15">
          <Nav />
        </aside>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
