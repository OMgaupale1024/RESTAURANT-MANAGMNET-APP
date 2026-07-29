# CRM & Customer Intelligence

The customer profile *is* the CRM. Read this before adding a customer metric or
a second "customer" surface. The first rule is *every figure is aggregated on
read from the tables that already own it — there is no customer analytics store,
no cached lifetime value, and no separate CRM module.*

## What it is

Opening one customer answers "who is this, what are they worth, what do they
buy, where do they stand, and what just happened" — all from existing data:

- **Intelligence cards** lead the profile: **lifetime value** (total captured
  spend), **average spend**, **visits**, and **visit frequency** — the last a
  new server-derived stat, `avgDaysBetweenVisits`. The existing **segment** chip
  and first/last-visit line stay; **tier** shows in the Loyalty section.
- **Favorite items** — the customer's top five items by quantity, grouped by the
  **sold name** (`name_snapshot`), from non-void orders only.
- **Refunds** — total returned, count, and the recent few (amount, method,
  reason, order number). Shown only when there is at least one.
- **Loyalty** — balance, tier, progress to next tier, and recent points entries,
  from the existing `LoyaltyService`. Hidden without `loyalty.read`.
- **Recent activity** — this customer's slice of the Timeline (the M5
  `audit_logs`), via a new optional `entityId` filter on `GET /reports/audit`,
  ending in a link into the full Timeline. Hidden without `audit.read`.

## Reuse decisions (what was NOT rebuilt)

The audit found the profile, segmentation, loyalty, orders and the Timeline all
already present. So M9 is additive:

- **Segment stays the shared classifier.** `marketing/segment.ts`
  (`classifySegment`) is the one authority; the profile renders its result and
  never re-implements the thresholds.
- **Loyalty stays `LoyaltyService.getSummary()`** behind the existing
  `GET /customers/:id/loyalty`. The frontend type simply extends to include the
  `recentEntries` the endpoint already returned — no endpoint change.
- **History is the Timeline's store.** The per-customer feed is the same
  `audit_logs`, read through the same enhanced `GET /reports/audit`, narrowed by
  `entityId`. No second history table, no per-customer event copy.
- **Favorite items follow `AnalyticsService.topProducts`'s shape** — a
  `groupBy(['nameSnapshot'])` with the same non-void rule — reusing the pattern,
  not a new per-customer item store.
- **Restaurant-wide customer/loyalty/refund analytics stay in
  `AnalyticsService.insights()`** (M6); the profile does not duplicate them per
  customer.
- **Graceful degradation reuses the documented loyalty idiom** — a caller
  without a permission gets a 403 the frontend swallows into an *absent* section,
  never an error or a partial render.

## Data flow

```
Profile open (customer id)
   ├─ getCustomer(id) ───────► CustomersService.getById   [customer.read]
   │     contact · stats {visits, LTV, avgBill, first/last, avgDaysBetweenVisits}
   │     · segment · recentOrders · favoriteItems · refunds
   ├─ getLoyaltySummary(id) ─► LoyaltyService.getSummary   [loyalty.read]
   │     balance · tier · nextTier · recentEntries      (on 403/err → omit)
   └─ getAudit({entityId}) ──► ReportsService.auditLog     [audit.read]
         this customer's audit rows, actor-named               (on 403/err → omit)
```

Three independent reads, each degrading on its own permission. The primary read
alone renders a complete profile; the other two only *enrich* it. All
aggregation happens in Postgres — the client receives sums and lists, never raw
rows to re-total.

## How the new figures are derived

- **`favoriteItems`** — `orderItem.groupBy(['nameSnapshot'])` where the order is
  the customer's and **countable** (not `VOIDED`/`CANCELLED`), summed by
  quantity, top 5. `name_snapshot` is what the receipt said, so a later product
  rename never rewrites history.
- **`refunds`** — `refund.aggregate` + a `take: 5` `findMany` over
  `order.customerId`. Deliberately **not** void-filtered: a refund on a later-
  voided order still left the till, and *a refund is a refund*. Joined via
  `order.customerId` because `refunds` carries no `customer_id` of its own.
- **`stats.avgDaysBetweenVisits`** — `round((lastVisit − firstVisit) / days /
  (visits − 1))` when `visits ≥ 2`, else `null` (one visit has no interval).
  Derived from values already read; no extra query. Powers the visit-frequency
  card so no client recomputes cadence.

## Performance

- Two more serial aggregates per profile open (favorite items, refund roll-up),
  inside the existing single-connection `prisma.tx` (serial, per the
  `@prisma/adapter-pg` rule) — profile-open is not a hot path.
- Each rides an existing index: `orders(customer_id)`,
  `order_items(order_id)`, `refunds(order_id)`. Milliseconds at real volumes;
  BACKLOG revisit only at tens of thousands of orders for one customer.
- The `entityId` filter is an equality on the indexed `audit_logs.entity_id`; it
  only ever narrows the scan.

## Security

- **`getById` stays `customer.read`.** Favorite items and refunds are
  order-derived facts of the same trust class as the spend stats and order
  history already returned there — a `customer.read` holder already sees this
  customer's orders and totals. No new route, so no new PII surface; KITCHEN
  still holds no customer permission.
- **Loyalty stays behind `loyalty.read`; activity behind `audit.read`** (the
  anti-theft record, seeded to OWNER/MANAGER). A missing permission yields a 403
  the frontend turns into an absent section — no leak, no error, no partial page.
- **RLS is the tenant boundary.** Every new read relies on it with no
  `restaurant_id` filter added, exactly like the surrounding code; cross-tenant
  `order_items`, `refunds` and `audit_logs` rows can never return (test-proven).
  The `entityId` filter is UUID-validated and can only narrow scope, never widen
  it.
- All new queries use Prisma parameterised `groupBy`/`aggregate`/relation
  filters — no string-interpolated SQL.

## Future extensibility

Found during review, **not** built:

- **At-risk (distinct from Lapsed)** — a "was-regular, now-slipping" cadence
  signal. `LAPSED` plus the win-back recommendation already cover the actionable
  case; a finer model waits for an owner to ask.
- **Per-restaurant segment thresholds** — currently constants; a settings
  concern for a later milestone.
- **Cached LTV / cohort retention / materialised views** — the architecture
  forbids caches and background jobs without measured evidence; add only under
  load, never speculatively.
- **No** separate CRM dashboard, **no** duplicated history, **no** client-side
  financial calculation — segments already live in Marketing → Segments.
