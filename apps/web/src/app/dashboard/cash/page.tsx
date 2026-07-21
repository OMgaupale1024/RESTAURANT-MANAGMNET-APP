import type { Metadata } from 'next';
import { CashClient } from './cash-client';

export const metadata: Metadata = {
  title: 'Day Close — OraOS',
  robots: { index: false, follow: false },
};

export default function CashPage() {
  return <CashClient />;
}
