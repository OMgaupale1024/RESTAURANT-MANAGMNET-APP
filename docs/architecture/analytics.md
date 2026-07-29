# Analytics & Business Insights

The owner's read on the business. Read this before adding a metric, a chart, or
a reporting query — the first rule here is *don't duplicate a number that
already has one true source.*

## What it is

Two endpoints over the live production tables, both `analytics.read`
(owner/manager), both aggregated entirely in Postgres inside one tenant-scoped
transaction:

- **`GET /analytics/overview`** (pre-existing) — core sales: revenue, orders,
  average bill, items sold, a daily revenue/orders series, top products, payment
  breakdown, peak hours. `AnalyticsService.overviewBetween` is the **single
  source** of these figures; Reports calls the same method for a custom window,
  so an exported total is the dashboard total by construction.
- **`GET /analytics/insights`** (this milestone) — everything else an owner
  asks: refunds & cancellations, customers (new/active/returning), loyalty
  (members, points in/out), and kitchen throughput (completed, prep time).

The web `/dashboard/analytics` page renders both for one selected window; the
home dashboard shows the day's slice of the overview. No new table, no
materialised copy, no reporting database, no background job — the audit found
none was required.

## Data sources

Every figure is derived, never stored:

| Group | Source table(s) | Aggregation |
| --- | --- | --- |
| Revenue / orders / AOV / items | `orders`, `order_items` | `SUM`/`COUNT`/`AVG` over countable orders |
| Revenue & orders trend | `orders` | `date_trunc` by IST day (raw SQL) |
| Top products | `order_items` | `groupBy nameSnapshot` (the sold name) |
| Payments | `payments` | `groupBy method`, CAPTURED only |
| Peak hours | `orders` | `EXTRACT(HOUR …)` in IST (raw SQL) |
| Refunds / refund rate | `refunds`, `orders` | `SUM(amount)` ÷ gross countable revenue |
| Cancellations | `orders` | `COUNT` where status VOIDED/CANCELLED |
| Customers | `customers`, `orders` | created-in-window; distinct orderers; orderers with a prior order |
| Loyalty | `loyalty_ledger` | distinct members; `SUM(points)` by sign/type |
| Kitchen prep | `order_events` | READY.at − PREPARING.at per order |

"Countable" everywhere means **not VOIDED/CANCELLED** — a reversed sale did not
happen, the same rule the customer stats and reports use.

## Metric definitions (and what is deliberately omitted)

Precision matters when an owner makes money decisions from these:

- **Refund rate** = refunded ÷ gross countable revenue, in integer basis points
  (a fractional-percent float is a rounding argument waiting to happen).
  Refunds are windowed by when money went **back**; gross by when the sale
  **landed**.
- **Customers** — `new` = accounts created in the window; `active` = distinct
  customers who placed a countable order in it; `returning` = those active
  customers who had **also** ordered before the window.
- **Loyalty** — `members` is the **lifetime** count of customers with any ledger
  row (a member is a member regardless of window). `pointsIssued` sums every
  credit in the window; `pointsRedeemed` counts REDEEM only — a negative ADJUST
  or an EXPIRE is a correction/lapse, not a customer redemption.
- **Kitchen** — `completed` counts orders reaching COMPLETED in the window. Prep
  time is the span from an order's PREPARING event to its READY event, so it is
  **only defined for orders that went through the kitchen**; `avgPrepSecs` /
  `longestPrepSecs` are `null` (shown as "—") when there are none, and
  `prepSamples` is the honest denominator behind the average.
- **Omitted — cohort retention rate.** A trustworthy retention figure needs a
  fixed cohort definition (retained *from when*, *over what window*) this
  milestone does not set. Rather than ship a number that looks precise and
  isn't, we show the returning **count** and let a future Customer-Analytics
  milestone define cohorts properly.

## Aggregation strategy & performance

- **Aggregate in the database, return scalars.** Raw order rows never leave
  Postgres — the client receives sums it cannot re-total wrongly. Prisma
  `aggregate`/`groupBy` where it expresses the query; parameterised raw SQL for
  `date_trunc`, `EXTRACT`, `FILTER`, and the kitchen CTE that `groupBy` cannot.
- **One transaction, serial queries.** `insights` runs its four blocks
  sequentially inside `prisma.tx` — one interactive transaction is one pg
  connection, and concurrent queries on it are unsafe under `@prisma/adapter-pg`
  (the same rule the overview follows). Serial is correct here, not slow: each
  block is a single indexed aggregate.
- **Indexes — all pre-existing, none added.** Every window scan rides a
  `(restaurant_id, created_at)` index: `orders`, `refunds`, `order_events`,
  `loyalty_ledger` all carry one; `customers` created-in-window uses the tenant
  index. The kitchen CTE groups `order_events` by `order_id` (its
  `(order_id, created_at)` index). No new index was required, so none was added.
- **No N+1, no repeated aggregation.** Each metric is one query; the page makes
  three calls total (overview + insights + the previous-period overview for the
  KPI deltas), not one per tile.

## Security

- `analytics.read` only — owner/manager; a cashier does not see the books
  (regression-tested). Enforced by `@RequirePermissions` + `PermissionsGuard`.
- **RLS is the boundary.** Every query — Prisma and raw SQL alike — runs inside
  `prisma.tx`, scoped to `app.restaurant_id` on a NOBYPASSRLS role, so a tenant
  can only ever aggregate its own rows. There is deliberately no `restaurant_id`
  filter written in any analytics query; RLS supplies it.
- **No new exposure.** Analytics returns aggregates over data the same user can
  already read row-by-row (orders, refunds, customers, loyalty, kitchen events).
  It reveals nothing a manager could not already reach.

## Accessibility

The insights are **number-forward** — a labelled figure with an optional
caption, inherently screen-reader friendly and readable at high contrast.
Sections are real `<h2>` headings. Charts (overview only) are used solely where
a shape beats a number (trend, hourly profile, method split), and each is paired
with its own textual KPI. Layouts are responsive grids that reflow to two
columns on small screens.

## Filtering

One model across the page: **Today · Yesterday · 7 / 30 / 90 days · Custom.**
Presets (today/7d/30d/90d) are server-resolved to IST bounds by
`AnalyticsService.bounds`. Yesterday and Custom resolve to explicit `from`/`to`
dates on the client and route through the same window contract Reports uses —
so the sales half (`/reports/sales`) and the insights half
(`/analytics/insights`) always cover the identical window.

## Future extensibility

Found during review, **not** built here:

- **Cohort retention & repeat-rate curves** — needs a cohort model (see above);
  its own milestone.
- **Per-tenant timezone** — the IST day is hardcoded (India-first). A settings
  row would feed the one `TZ` constant the aggregations already share.
- **Product/category profitability** — needs ingredient cost joined to sales;
  the stock ledger has cost, the link is a future query, not a new store.
- **Materialised daily rollups** — only if a tenant's `orders` grows past what a
  windowed indexed aggregate serves interactively. The audit found live
  aggregation ample today; a rollup is a scaling answer to a problem no tenant
  has yet, so it stays unbuilt (YAGNI).
