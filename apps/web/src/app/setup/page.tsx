import type { Metadata } from 'next';
import { SetupForm } from './setup-form';

export const metadata: Metadata = {
  title: 'Set up your restaurant — OraOS',
  robots: { index: false, follow: false },
};

export default function SetupPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-16">
      <span className="text-lg font-semibold tracking-tight">OraOS</span>

      <h1 className="mt-8 text-2xl font-semibold tracking-tight">
        Set up your restaurant
      </h1>
      <p className="mt-2 mb-6 text-sm text-black/70 dark:text-white/70">
        You can change any of this later.
      </p>

      <SetupForm />
    </main>
  );
}
