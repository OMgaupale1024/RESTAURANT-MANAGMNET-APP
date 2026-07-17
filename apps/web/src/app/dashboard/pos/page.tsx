import type { Metadata } from 'next';
import { PosClient } from './pos-client';

export const metadata: Metadata = {
  title: 'POS — OraOS',
  robots: { index: false, follow: false },
};

export default function PosPage() {
  return <PosClient />;
}
