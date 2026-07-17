import type { Metadata } from 'next';
import { OrdersClient } from './orders-client';

export const metadata: Metadata = {
  title: 'Orders — OraOS',
  robots: { index: false, follow: false },
};

export default function OrdersPage() {
  return <OrdersClient />;
}
