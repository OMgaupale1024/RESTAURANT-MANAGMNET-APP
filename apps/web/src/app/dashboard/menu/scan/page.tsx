import type { Metadata } from 'next';
import { ScanClient } from './scan-client';

export const metadata: Metadata = {
  title: 'Scan menu — OraOS',
  robots: { index: false, follow: false },
};

export default function ScanMenuPage() {
  return <ScanClient />;
}
