import type { Metadata } from 'next';
import { CustomersClient } from './customers-client';

export const metadata: Metadata = {
  title: 'Customers — OraOS',
  robots: { index: false, follow: false },
};

export default function CustomersPage() {
  return <CustomersClient />;
}
