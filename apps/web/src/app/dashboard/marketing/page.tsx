import type { Metadata } from 'next';
import { MarketingClient } from './marketing-client';

export const metadata: Metadata = {
  title: 'Marketing — OraOS',
  robots: { index: false, follow: false },
};

export default function MarketingPage() {
  return <MarketingClient />;
}
