/**
 * Dashboard home.
 *
 * Deliberately empty of data. The blueprint's philosophy is that every screen
 * answers "what happened / why / what next" — but the answers need orders,
 * inventory and analytics, none of which exist yet. Inventing plausible-looking
 * numbers here would be worse than showing none: a fake metric on a business
 * dashboard is a lie the owner might act on.
 *
 * This step ships the shell and navigation. Each section fills in at its step.
 */
export default function DashboardPage() {
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
      <p className="mt-2 text-sm text-black/70 dark:text-white/70">
        Your restaurant is set up. Sections unlock as they are built.
      </p>

      <div className="mt-6 rounded-lg border border-black/10 p-6 dark:border-white/15">
        <h2 className="font-semibold">Nothing to show yet</h2>
        <p className="mt-2 text-sm text-black/70 dark:text-white/70">
          Once you start taking orders, this is where the day’s revenue, covers
          and trends will appear.
        </p>
      </div>
    </div>
  );
}
