import type { Metadata } from 'next';
import { StaffClient } from './staff-client';

export const metadata: Metadata = {
  title: 'Staff — OraOS',
  robots: { index: false, follow: false },
};

export default function StaffPage() {
  return <StaffClient />;
}
