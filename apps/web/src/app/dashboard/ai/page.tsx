import type { Metadata } from 'next';
import { AiClient } from './ai-client';

export const metadata: Metadata = {
  title: 'AI Center — OraOS',
  robots: { index: false, follow: false },
};

export default function AiPage() {
  return <AiClient />;
}
