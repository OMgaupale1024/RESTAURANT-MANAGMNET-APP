import type { Metadata } from 'next';
import { SetupForm } from './setup-form';
import { Card } from '@/components/ui/card';

export const metadata: Metadata = {
  title: 'Set up your restaurant — OraOS',
  robots: { index: false, follow: false },
};

export default function SetupPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-16 animate-fade-up">
      <div className="mb-8 text-center">
        <span className="text-xl font-semibold tracking-tight">OraOS</span>
      </div>
      <Card className="p-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Set up your restaurant
        </h1>
        <p className="mt-2 mb-6 text-sm text-ink-2">
          You can change any of this later.
        </p>

        <SetupForm />
      </Card>
    </main>
  );
}
