import type { Metadata } from 'next';
import { JoinClient } from './join-client';

export const metadata: Metadata = {
  title: 'Join a restaurant — OraOS',
  robots: { index: false, follow: false },
};

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-16">
      <span className="mb-8 text-lg font-semibold tracking-tight">OraOS</span>
      <JoinClient token={token} />
    </main>
  );
}
