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
    <div className="flex min-h-dvh">
      {/* Left 45% Brand Panel */}
      <div className="theme-dark bg-page text-ink hidden w-[45%] flex-col justify-between overflow-hidden p-12 lg:flex relative">
        <div className="relative z-10">
          <Link href="/" className="text-xl font-semibold tracking-tight">
            OraOS
          </Link>
          <p className="mt-4 max-w-sm text-lg text-white/70">
            The AI operating system for restaurants.
          </p>
        </div>
        {/* Subtle animated yellow orb-gradient */}
        <div className="absolute inset-0 z-0 flex items-center justify-center opacity-30">
          <div className="h-[40rem] w-[40rem] rounded-full bg-brand blur-[128px] animate-pulse" style={{ animationDuration: '4s' }} />
        </div>
      </div>
      
      {/* Right 55% Form */}
      <main className="flex flex-1 flex-col justify-center px-6 py-16 lg:px-12 bg-page">
        <div className="mx-auto w-full max-w-[360px]">
          <div className="lg:hidden mb-8">
            <Link href="/" className="text-xl font-semibold tracking-tight">
              OraOS
            </Link>
          </div>
          <h1 className="mb-6 text-2xl font-semibold tracking-tight">
            Sign in
          </h1>
          <LoginForm />
        </div>
      </main>
    </div>
  );
}
