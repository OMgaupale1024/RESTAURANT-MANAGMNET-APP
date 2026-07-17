import type { Metadata } from 'next';
import { KitchenClient } from './kitchen-client';

export const metadata: Metadata = {
  title: 'Kitchen — OraOS',
  robots: { index: false, follow: false },
};

export default function KitchenPage() {
  return <KitchenClient />;
}
