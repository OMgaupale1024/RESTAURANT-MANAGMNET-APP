import type { Metadata } from 'next';
import Link from 'next/link';
import { ResetPasswordForm } from './reset-password-form';

export const metadata: Metadata = {
  title: 'Choose a new password — OraOS',
  robots: { index: false, follow: false },
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-16 animate-fade-up">
      <div className="mb-8 text-center">
        <Link href="/" className="text-xl font-semibold tracking-tight">
          OraOS
        </Link>
      </div>
      <ResetPasswordForm token={token ?? ''} />
    </main>
  );
}
