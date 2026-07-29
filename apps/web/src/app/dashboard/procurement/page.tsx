import type { Metadata } from 'next';
import { ProcurementClient } from './procurement-client';

export const metadata: Metadata = {
  title: 'Procurement — OraOS',
  robots: { index: false, follow: false },
};

export default function ProcurementPage() {
  return <ProcurementClient />;
}
