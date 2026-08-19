import type { Metadata } from 'next';
import { StockCountClient } from './count-client';

export const metadata: Metadata = {
  title: 'Stock count — OraOS',
  robots: { index: false, follow: false },
};

export default function StockCountPage() {
  return <StockCountClient />;
}
