import type { Metadata } from 'next';
import { InventoryClient } from './inventory-client';

export const metadata: Metadata = {
  title: 'Inventory — OraOS',
  robots: { index: false, follow: false },
};

export default function InventoryPage() {
  return <InventoryClient />;
}
