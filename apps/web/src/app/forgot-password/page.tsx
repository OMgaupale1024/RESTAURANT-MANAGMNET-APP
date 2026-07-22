import type { Metadata } from 'next';
import Link from 'next/link';
import { ForgotPasswordForm } from './forgot-password-form';

export const metadata: Metadata = {
  title: 'Reset your password — OraOS',
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-16 animate-fade-up">
      <div className="mb-8 text-center">
        <Link href="/" className="text-xl font-semibold tracking-tight">
          OraOS
        </Link>
      </div>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">
        Reset your password
      </h1>
      <p className="mb-6 text-sm text-ink-2">
        Enter your email and we&apos;ll send you a link to set a new password.
      </p>
      <ForgotPasswordForm />
      <p className="mt-6 text-center text-sm text-ink-3">
        <Link href="/login" className="underline hover:text-ink-1">
          Back to sign in
        </Link>
      </p>
    </main>
  );
}
