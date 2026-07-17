import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DashboardShell } from './dashboard-shell';

export const metadata: Metadata = {
  title: 'Dashboard — OraOS',
  robots: { index: false, follow: false },
};

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
