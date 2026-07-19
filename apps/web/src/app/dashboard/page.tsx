import { DashboardClient } from './dashboard-client';

/**
 * The owner's morning briefing (DESIGN.md §6). Everything on this page is
 * served by existing endpoints — analytics overview, AI insights, low-stock
 * ingredients, active orders, and the two real socket events. Nothing here
 * fabricates a number the API did not compute.
 */
export default function DashboardPage() {
  return <DashboardClient />;
}
