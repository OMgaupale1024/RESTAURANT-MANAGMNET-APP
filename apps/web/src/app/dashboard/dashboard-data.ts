import type { AiInsight, AnalyticsOverview, MeResponse, OrderSummary } from '@/lib/api';

// Statuses that count as "on the board" for the kitchen brief and the feed seed.
const ACTIVE_STATUSES = ['PLACED', 'PREPARING', 'READY'];

/**
 * The dashboard loads six independent things. Only the two analytics calls are
 * *core* — the headline numbers and the revenue trend the page is built around.
 * Everything else (AI insights, low-stock count, active orders, the greeting
 * name) is a side widget that can be absent without the page losing meaning.
 *
 * `ok: false` means the core could not load, so there is nothing honest to show.
 * `ok: true` always carries today+week; each side widget is either its value or
 * a neutral fallback (`[]`, `null`) — a failure there never fails the page.
 */
export type DashboardLoad =
  | { ok: false; error: string }
  | {
      ok: true;
      today: AnalyticsOverview;
      week: AnalyticsOverview;
      insights: AiInsight[];
      lowStock: number | null;
      /** null = active orders could not be loaded (an explicit widget error);
       *  distinct from [] = loaded, nothing active. */
      active: OrderSummary[] | null;
      firstName: string;
    };

type S<T> = PromiseSettledResult<T>;

/**
 * The API's message when a settled call rejected with an ApiRequestError, else a
 * generic line — never a raw network/JS error string leaked as UI copy. Detected
 * by `name` so this module imports nothing from the API client (keeps it, and
 * its test, free of fetch/socket code).
 */
function coreErrorMessage(...reasons: unknown[]): string {
  for (const r of reasons) {
    if (
      r &&
      typeof r === 'object' &&
      (r as { name?: string }).name === 'ApiRequestError' &&
      typeof (r as { message?: unknown }).message === 'string'
    ) {
      return (r as { message: string }).message;
    }
  }
  return 'Could not load the dashboard';
}

/**
 * Fold the six settled loads into render state. This is the fix for the blank
 * dashboard: the old code awaited a single `Promise.all`, so ONE failing
 * endpoint (a 500 on /orders) rejected the batch and discarded the five healthy
 * widgets. Here a side widget's failure degrades only that widget.
 */
export function reconcileDashboardLoad(r: {
  today: S<AnalyticsOverview>;
  week: S<AnalyticsOverview>;
  insights: S<{ insights: AiInsight[] }>;
  ingredients: S<readonly unknown[]>;
  active: S<OrderSummary[]>;
  me: S<MeResponse>;
}): DashboardLoad {
  if (r.today.status !== 'fulfilled' || r.week.status !== 'fulfilled') {
    return {
      ok: false,
      error: coreErrorMessage(
        r.today.status === 'rejected' ? r.today.reason : undefined,
        r.week.status === 'rejected' ? r.week.reason : undefined,
      ),
    };
  }

  return {
    ok: true,
    today: r.today.value,
    week: r.week.value,
    insights:
      r.insights.status === 'fulfilled'
        ? [...r.insights.value.insights].sort((a, b) =>
            a.severity === b.severity ? 0 : a.severity === 'warning' ? -1 : 1,
          )
        : [],
    lowStock: r.ingredients.status === 'fulfilled' ? r.ingredients.value.length : null,
    active:
      r.active.status === 'fulfilled'
        ? r.active.value.filter((o) => ACTIVE_STATUSES.includes(o.status))
        : null,
    firstName:
      r.me.status === 'fulfilled' ? r.me.value.user.name.split(' ')[0] : '',
  };
}
