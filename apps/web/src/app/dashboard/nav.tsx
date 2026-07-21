'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLayoutEffect, useRef, useState } from 'react';
import {
  BookOpen,
  ChefHat,
  FileText,
  LayoutDashboard,
  Megaphone,
  Package,
  Receipt,
  Sparkles,
  Store,
  TrendingUp,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';

export type NavItem = { label: string; href: string; icon: LucideIcon };

/** Groups mirror the blueprint's product loop: record → understand → act. */
export const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Overview',
    items: [{ label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'Operate',
    items: [
      { label: 'POS', href: '/dashboard/pos', icon: Store },
      { label: 'Orders', href: '/dashboard/orders', icon: Receipt },
      { label: 'Kitchen', href: '/dashboard/kitchen', icon: ChefHat },
    ],
  },
  {
    label: 'Understand',
    items: [
      { label: 'Analytics', href: '/dashboard/analytics', icon: TrendingUp },
      { label: 'Reports', href: '/dashboard/reports', icon: FileText },
    ],
  },
  {
    label: 'Grow',
    items: [
      { label: 'Customers', href: '/dashboard/customers', icon: Users },
      { label: 'Marketing', href: '/dashboard/marketing', icon: Megaphone },
    ],
  },
  {
    label: 'Manage',
    items: [
      { label: 'Menu', href: '/dashboard/menu', icon: BookOpen },
      { label: 'Inventory', href: '/dashboard/inventory', icon: Package },
      { label: 'Staff', href: '/dashboard/staff', icon: UserCog },
    ],
  },
  {
    label: 'Intelligence',
    items: [{ label: 'AI Center', href: '/dashboard/ai', icon: Sparkles }],
  },
];

/**
 * Which nav targets a role sees. UX only — the API + RLS are the boundary;
 * hiding a link never protects anything, it just avoids offering screens
 * whose requests would 403.
 */
export function allowedHrefs(roleKey: string): Set<string> | null {
  const key = roleKey.toUpperCase();
  if (key === 'KITCHEN') return new Set(['/dashboard/kitchen']);
  if (key === 'CASHIER')
    return new Set([
      '/dashboard/pos',
      '/dashboard/orders',
      '/dashboard/kitchen',
      '/dashboard/customers',
    ]);
  return null; // OWNER / MANAGER: everything
}

export function groupsForRole(roleKey: string) {
  const allowed = allowedHrefs(roleKey);
  if (!allowed) return NAV_GROUPS;
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => allowed.has(i.href)),
  })).filter((g) => g.items.length > 0);
}

/** Where a role lands when it hits /dashboard. */
export function homeForRole(roleKey: string): string {
  const key = roleKey.toUpperCase();
  if (key === 'KITCHEN') return '/dashboard/kitchen';
  if (key === 'CASHIER') return '/dashboard/pos';
  return '/dashboard';
}

/**
 * Sidebar nav with a sliding active pill: one absolutely-positioned element
 * moved with translateY to the measured offset of the active row — the cheap
 * form of a shared-element transition.
 */
export function SidebarNav({
  roleKey,
  collapsed,
  onNavigate,
}: {
  roleKey: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const listRef = useRef<HTMLDivElement>(null);
  const [pillY, setPillY] = useState<number | null>(null);
  const groups = groupsForRole(roleKey);

  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    setPillY(el ? el.offsetTop : null);
  }, [pathname, collapsed, roleKey]);

  return (
    <nav aria-label="Sections" className="flex-1 overflow-y-auto px-3 py-2">
      <div ref={listRef} className="relative">
        {pillY !== null && (
          <span
            aria-hidden
            className="absolute inset-x-0 top-0 h-8 rounded-lg border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-transform duration-240 ease-(--ease-spring)"
            style={{ transform: `translateY(${pillY}px)` }}
          >
            {/* Brand rail rides the pill; the height ease lands a beat after the slide. */}
            <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-brand transition-[top,bottom] duration-240 ease-(--ease-out-quart)" />
          </span>
        )}

        {groups.map((group, gi) => (
          <div key={group.label}>
            {collapsed ? (
              gi > 0 && <div className="mx-2 my-2 border-t border-line" />
            ) : (
              <p className={cn('text-label px-3 pb-1', gi === 0 ? 'pt-1' : 'pt-5')}>
                {group.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = pathname === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      data-active={active}
                      aria-current={active ? 'page' : undefined}
                      title={collapsed ? item.label : undefined}
                      onClick={onNavigate}
                      className={cn(
                        'group relative z-10 flex h-8 items-center gap-2.5 rounded-lg px-3 text-sm transition-[background-color,color,transform] duration-120',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current',
                        collapsed && 'justify-center px-0',
                        active
                          ? 'text-ink'
                          : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                        !active && !collapsed && 'hover:translate-x-0.5',
                      )}
                    >
                      <item.icon
                        aria-hidden
                        className={cn(
                          'size-4 shrink-0 transition-colors duration-180',
                          active ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2',
                        )}
                      />
                      {!collapsed && (
                        <span
                          className={cn(
                            'truncate transition-[font-weight] duration-180',
                            active && 'font-medium',
                          )}
                        >
                          {item.label}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
