import type { Metadata } from 'next';
import Link from 'next/link';
import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Sign in — OraOS',
  // Nothing here should ever surface in search results.
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-16">
      <Link href="/" className="text-lg font-semibold tracking-tight">
        OraOS
      </Link>

      <h1 className="mt-8 mb-6 text-2xl font-semibold tracking-tight">
        Sign in
      </h1>

      <LoginForm />
    </main>
  );
}
