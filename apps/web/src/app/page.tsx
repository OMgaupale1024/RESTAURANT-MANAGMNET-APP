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
    <div className="flex min-h-full flex-col">
      <header className="border-b border-black/10 dark:border-white/15">
        <nav
          className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4"
          aria-label="Main"
        >
          <span className="text-lg font-semibold tracking-tight">OraOS</span>
          <Link
            href="/login"
            className="rounded-md px-3 py-2 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
          >
            Sign in
          </Link>
        </nav>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-5xl px-6 py-20">
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            The AI operating system for restaurants
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-black/70 dark:text-white/70">
            Most restaurant software records what you sold. OraOS tells you why
            it sold, what tomorrow looks like, and what to do about it.
          </p>

          <div className="mt-10 flex flex-wrap gap-3">
            <Link
              href="/register"
              className="rounded-md bg-brand px-5 py-3 text-sm font-semibold text-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current hover:brightness-95"
            >
              Get started
            </Link>
            <Link
              href="/login"
              className="rounded-md border border-black/20 px-5 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current hover:bg-black/5 dark:border-white/25 dark:hover:bg-white/10"
            >
              Sign in
            </Link>
          </div>
        </section>

        <section
          className="mx-auto max-w-5xl px-6 pb-24"
          aria-labelledby="how-it-works"
        >
          <h2 id="how-it-works" className="sr-only">
            How OraOS helps
          </h2>
          <ul className="grid gap-6 sm:grid-cols-3">
            {VALUE_POINTS.map((point) => (
              <li
                key={point.title}
                className="rounded-lg border border-black/10 p-6 dark:border-white/15"
              >
                <h3 className="font-semibold">{point.title}</h3>
                <p className="mt-2 text-sm text-black/70 dark:text-white/70">
                  {point.body}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t border-black/10 dark:border-white/15">
        <div className="mx-auto max-w-5xl px-6 py-6 text-sm text-black/60 dark:text-white/60">
          © {new Date().getFullYear()} OraOS
        </div>
      </footer>
    </div>
  );
}
