import type { Metadata } from 'next';
import { AuditClient } from './audit-client';

export const metadata: Metadata = {
  title: 'Timeline — OraOS',
  robots: { index: false, follow: false },
};

export default function AuditPage() {
  return <AuditClient />;
}
