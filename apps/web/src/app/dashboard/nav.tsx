'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Navigation shell.
 *
 * Only Dashboard is a link, because only Dashboard exists. The rest are shown
 * as disabled so the shape of the product is visible without pretending — a
 * nav item linking to a 404 is worse than one that says "not yet".
 *
 * Each becomes a link in the step that builds it. `href: null` is the marker.
 */
const ITEMS: Array<{ label: string; href: string | null }> = [
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'POS', href: '/dashboard/pos' },
  { label: 'Orders', href: '/dashboard/orders' },
  { label: 'Customers', href: '/dashboard/customers' },
  { label: 'Inventory', href: '/dashboard/inventory' },
  { label: 'Employees', href: '/dashboard/staff' },
  { label: 'Kitchen', href: '/dashboard/kitchen' },
  { label: 'Analytics', href: '/dashboard/analytics' },
  { label: 'Reports', href: '/dashboard/reports' },
  { label: 'AI Center', href: '/dashboard/ai' },
  { label: 'Marketing', href: '/dashboard/marketing' },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Sections" className="p-3">
      <ul className="flex gap-1 overflow-x-auto md:block md:space-y-1 md:overflow-visible">
        {ITEMS.map((item) => {
          const active = item.href === pathname;

          if (!item.href) {
            return (
              <li key={item.label}>
                <span
                  aria-disabled="true"
                  title="Not built yet"
                  className="block cursor-not-allowed rounded-md px-3 py-2 text-sm whitespace-nowrap text-black/35 dark:text-white/35"
                >
                  {item.label}
                </span>
              </li>
            );
          }

          return (
            <li key={item.label}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`block rounded-md px-3 py-2 text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current ${
                  active
                    ? 'bg-black/5 font-medium dark:bg-white/10'
                    : 'hover:bg-black/5 dark:hover:bg-white/10'
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
