import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'OraOS — AI Restaurant Operating System',
  description:
    'OraOS tells you what happened, why it happened, what is coming, and what to do next. Not just another POS.',
};

// The product philosophy from docs/BLUEPRINT.md §1, in the owner's words.
// Deliberately three, not eight: a landing page that lists everything says
// nothing.
const VALUE_POINTS = [
  {
    title: 'Understand',
    body: 'Every sale, cost and customer in one place. See why yesterday was slow, not just that it was.',
  },
  {
    title: 'Predict',
    body: 'Tomorrow’s demand, item by item. Order the right stock, roster the right staff, waste less.',
  },
  {
    title: 'Act',
    body: 'Ask a question, get an answer from your own data. OraOS suggests the next move every morning.',
  },
];

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-page">
      {/* Hero section gets the dark brand panel treatment */}
      <div className="relative overflow-hidden bg-[#0a0a0a] text-[#ededed]">
        {/* Subtle animated yellow orb-gradient */}
        <div className="absolute inset-x-0 top-0 z-0 flex justify-center opacity-30 pointer-events-none">
          <div className="h-[40rem] w-[40rem] -translate-y-1/2 rounded-full bg-brand blur-[128px] animate-pulse" style={{ animationDuration: '4s' }} />
        </div>

        <header className="relative z-10 border-b border-white/10">
          <nav
            className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4"
            aria-label="Main"
          >
            <span className="text-lg font-semibold tracking-tight">OraOS</span>
            <Link
              href="/login"
              className="rounded-md px-3 py-2 text-sm font-medium transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current text-white/80"
            >
              Sign in
            </Link>
          </nav>
        </header>

        <section className="relative z-10 mx-auto max-w-5xl px-6 py-24 sm:py-32 text-center">
          <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl text-white">
            The AI operating system for restaurants
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-white/70">
            Most restaurant software records what you sold. OraOS tells you why
            it sold, what tomorrow looks like, and what to do about it.
          </p>

          <div className="mt-10 flex flex-wrap justify-center gap-4">
            <Link
              href="/register"
              className="rounded-md bg-brand px-6 py-3 text-sm font-semibold text-brand-ink transition-colors duration-120 hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
            >
              Get started
            </Link>
          </div>
        </section>
      </div>

      <main className="flex-1">
        <section
          className="mx-auto max-w-5xl px-6 py-24"
          aria-labelledby="how-it-works"
        >
          <h2 id="how-it-works" className="sr-only">
            How OraOS helps
          </h2>
          <ul className="grid gap-6 sm:grid-cols-3">
            {VALUE_POINTS.map((point) => (
              <li
                key={point.title}
                className="rounded-xl border border-line bg-surface p-6 shadow-[0_1px_2px_rgb(0_0_0/0.04)]"
              >
                <h3 className="font-semibold text-ink">{point.title}</h3>
                <p className="mt-2 text-sm text-ink-2">
                  {point.body}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t border-line bg-surface-2">
        <div className="mx-auto max-w-5xl px-6 py-8 text-sm text-ink-3">
          © {new Date().getFullYear()} OraOS
        </div>
      </footer>
    </div>
  );
}
