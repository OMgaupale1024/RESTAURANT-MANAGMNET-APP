import type { Metadata } from 'next';
import { PrepClient } from './prep-client';

export const metadata: Metadata = {
  title: 'Prep — OraOS',
  robots: { index: false, follow: false },
};

export default function PrepPage() {
  return <PrepClient />;
}
