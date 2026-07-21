import type { Metadata } from 'next';
import { MenuClient } from './menu-client';

export const metadata: Metadata = {
  title: 'Menu — OraOS',
  robots: { index: false, follow: false },
};

export default function MenuPage() {
  return <MenuClient />;
}
