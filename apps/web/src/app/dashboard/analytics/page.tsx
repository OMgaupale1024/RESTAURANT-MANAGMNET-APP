import type { Metadata } from 'next';
import { AnalyticsClient } from './analytics-client';

export const metadata: Metadata = {
  title: 'Analytics — OraOS',
  robots: { index: false, follow: false },
};

export default function AnalyticsPage() {
  return <AnalyticsClient />;
}
