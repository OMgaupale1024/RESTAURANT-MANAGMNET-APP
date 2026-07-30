# M9 — CRM & Customer Intelligence — Design Document

**Status:** Proposed (awaiting approval)
**Date:** 2026-07-29
**Scope:** approved by product on 2026-07-29 — extend the existing Customer
Profile into the Customer Intelligence layer; no separate CRM dashboard.

---

## 1. Objectives

1. **Make the existing Customer Profile the single Customer Intelligence
   surface.** An owner opens one customer and immediately understands their
   value, habits, loyalty standing, refunds, and recent activity.
2. **Implement only the genuine gaps** found in the audit — loyalty section,
   refund history, favorite items, per-customer timeline, and intelligence
   cards — as **additive** changes to what already exists.
3. **Preserve every existing source of truth.** Zero duplicated customer,
   loyalty, order, segmentation, analytics, or timeline logic; every figure
   server-derived.
4. **Ship safely:** tests, documentation, roadmap update, no regressions, and
   manual verification before commit.

### Alignment with engineering principles

| Principle | How this design honours it |
|---|---|
| Audit first | Full audit completed; gaps enumerated before any design. |
| Reuse before creating | Loyalty, segments, orders, timeline, analytics reused as-is. |
| Extend before rewriting | One service method + one DTO field extended; nothing rewritten. |
| Single source of truth | Segment ← `segment.ts`; loyalty ← `LoyaltyService`; history ← existing tables. |
| Server-authoritative calculations | LTV, avg spend, visit frequency, favorites, refunds all computed in Postgres. |
| No duplicated business logic | No re-implemented segmentation, loyalty math, or timeline read. |
| No duplicated data models/history | No new table, view, cache, or counter; joins into existing rows. |

---

## 2. Architecture overview

The profile is a **read model aggregated on demand** inside one tenant-scoped,
RLS-protected transaction — the stance the codebase already documents
("aggregate on read; no cached counter to drift"). M9 adds no structural
element. Every new figure derives from tables that already exist:

| Signal | Source of truth (unchanged) |
|---|---|
| LTV, Avg spend, Visits, First/Last visit, **Visit frequency** | `orders` |
| Favorite items | `order_items` (`name_snapshot`) |
| Refund history | `refunds` (via `order.customer_id`) |
| Loyalty status, tier, points history | `loyalty_ledger` (via `LoyaltyService`) |
| Segment | `marketing/segment.ts` (shared classifier) |
| Recent activity | `audit_logs` (M5 Timeline store) |

No new table, materialized view, cache, or background job. RLS scopes every
query; there is deliberately no `restaurant_id` filter in the new reads, exactly
like the surrounding code.

---

## 3. Existing systems to reuse (untouched)

- **`marketing/segment.ts`** — `classifySegment` / `SEGMENT_META`: the single
  segmentation authority; the profile already renders its result.
- **`LoyaltyService.getSummary()`** + `GET /customers/:id/loyalty` — already
  returns balance, lifetime earned, redeemed, tier, next-tier, and the last 10
  ledger entries. Called, never reimplemented.
- **`AnalyticsService.topProducts()` pattern** — favorite items copy its
  `groupBy(['nameSnapshot'])` shape (the pattern, not the method).
- **`AnalyticsService.insights()`** — remains the home of restaurant-wide
  customer/loyalty/refund analytics; not duplicated per profile.
- **M5 Timeline** (`reports.auditLog` + `audit-client.tsx`) — the profile links
  into it rather than rendering a second timeline.
- **Orders** — `recentOrders` (Recent Visits) already on the profile.
- **Frontend idiom** — `getLoyaltySummary` already exists, documented as
  "callers treat a failure as 'no loyalty' and omit it." Same graceful
  degradation reused for every permission-gated section.

---

## 4. Components/services to extend

### 4.1 `CustomersService.getById()` — add derived reads (no new endpoint)

Two additional serial queries inside the existing transaction (which already
runs four — same single-pg-connection safety):

- **`favoriteItems`** — `orderItem.groupBy(['nameSnapshot'])` where
  `order.customerId = id` and status is `COUNTABLE` (non-void), summed by
  `quantity`, ordered by quantity desc, `take: 5`. `name_snapshot` is what the
  receipt said → no product join, rename-safe.
- **`refunds`** — `{ totalMinor, count, recent[] }` from `refund.aggregate` +
  `refund.findMany` where `order.customerId = id`, `take: 5` (amount, method,
  reason, order number, date). Refunds are **not** subject to the void
  exclusion — a refund is a refund.

Plus one derived stat (no extra query — uses values already read):

- **`stats.avgDaysBetweenVisits`** — `round((lastVisit − firstVisit) /
  (visits − 1))` when `visits ≥ 2`, else `null`. Powers the Visit-Frequency
  card, server-derived.

### 4.2 `ReportsService.auditLog()` + `AuditLogQuery` — optional `entityId`

Add an optional UUID-validated `entityId` query param. When present,
`where.entityId = entityId`. ~4 service lines + one DTO field. Yields the
per-customer slice of the Timeline and strengthens the global Timeline. No new
query, no new store.

---

## 5. API changes

| Endpoint | Change |
|---|---|
| `GET /customers/:id` | Response gains `favoriteItems[]`, `refunds{}`, `stats.avgDaysBetweenVisits`. Additive; existing fields unchanged. |
| `GET /reports/audit` | Accepts optional `entityId` (UUID) filter. Narrows only. |
| `GET /customers/:id/loyalty` | **No change** — already complete; frontend type extends to include the existing `recentEntries`. |

No new endpoints. `api.ts` types extend: `CustomerDetail += favoriteItems,
refunds, stats.avgDaysBetweenVisits`; `LoyaltySummary += recentEntries`;
`entityId` param on the audit fetch.

---

## 6. Data flow

```
Profile open (customer id)
        │
        ├─ getCustomer(id) ───────────► CustomersService.getById   [customer.read]
        │      returns: contact, stats {visits, LTV=totalSpent, avgBill,
        │      first/last visit, avgDaysBetweenVisits}, segment,
        │      recentOrders, favoriteItems, refunds
        │
        ├─ getLoyaltySummary(id) ─────► LoyaltyService.getSummary  [loyalty.read]
        │      returns: balance, tier, nextTier, recentEntries
        │      (on 403/err → omit Loyalty section)
        │
        └─ getAudit({entityId: id}) ──► ReportsService.auditLog    [audit.read]
               returns: this customer's audit rows (actor-named)
               (on 403/err → omit Activity section)
```

Three independent reads fired in parallel, each degrading on its own
permission. The primary read alone renders a complete profile; the other two
only *enrich* it. All aggregation happens in Postgres — the client receives
sums and lists, never raw rows to re-total.

---

## 7. UI/UX changes — `apps/web`, `customers-client.tsx` (profile Sheet only)

Existing top of sheet (contact, segment chip, spend stats, order history,
notes, edit) stays. Changes:

1. **Intelligence cards** — present the headline stats as a clear card row,
   reusing existing `SheetStat`/`StatCard` + `SegmentChip`: **LTV** (total
   spent), **Avg spend**, **Visit frequency** (`avgDaysBetweenVisits` → "≈ every
   N days"), **Last visit**, **Segment**, **Tier** (from loyalty; omitted when
   loyalty hidden). No new component.
2. **Loyalty** section — balance, tier + progress to next tier, recent points
   entries. Hidden without `loyalty.read`.
3. **Favorite items** — top 5, "Item ×N".
4. **Refunds** — total returned + recent list. Shown only if `count > 0`.
5. **Recent activity** — compact feed from the customer-filtered audit log,
   ending in "View in Timeline →". Hidden without `audit.read`.

The customer **list** and **CSV export** are unchanged. Sections that fail to
load simply do not render — never an error state (matches the documented
loyalty idiom).

---

## 8. Security and authorization considerations

- **PII posture unchanged.** Customer records are PII; every customer route
  already requires an explicit permission and KITCHEN holds none. M9 adds no
  route, so no new PII surface.
- **`getById` stays `customer.read`.** Favorite items and refunds are
  order-derived facts — the same trust class as the spend stats and order
  history already returned there. No privilege escalation; a `customer.read`
  holder already sees this customer's orders and totals.
- **Loyalty stays behind `loyalty.read`;** activity behind `audit.read` (the
  anti-theft record, seeded only to OWNER/MANAGER). A user without a permission
  gets a 403 that the frontend swallows into an absent section — **no data
  leak, no error, no partial render.**
- **RLS is the tenant boundary.** Every new read relies on RLS, with no
  `restaurant_id` filter added (consistent with the codebase). Cross-tenant
  `order_items`, `refunds`, and `audit_logs` rows can never be returned;
  proven by test. The `entityId` filter is UUID-validated and only **narrows**
  scope — it can never widen it.
- **No new PII in the audit store.** We only *read* `audit_logs`; existing
  events already avoid copying name/phone into metadata. Unchanged.
- **Injection.** All new queries use Prisma parameterised
  `groupBy`/`aggregate`/relation filters; no string interpolation into SQL.

---

## 9. Testing strategy

Reuse the existing Jest + e2e harness; no new framework.

- **Favorite items** — voided/cancelled orders excluded; grouped by
  `name_snapshot`; empty-safe for a customer with no items.
- **Refunds** — per-customer total and count sum only that customer's orders'
  refunds; empty-safe.
- **`avgDaysBetweenVisits`** — `null` at <2 visits; correct rounding at ≥2.
- **`auditLog` entityId filter** — returns only that entity's rows and stays
  RLS-scoped (another tenant's rows never appear).
- **Regression** — existing customer/loyalty/reports suites stay green.
- **Gate** — lint, typecheck, build, unit + e2e all pass; manual browser
  verification of the enriched profile before commit.

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Two more serial aggregates per profile open | Profile-open is not a hot path; all reads indexed (`orders(customerId)`, `order_items(orderId)`, `refunds(orderId)`), ms-scale. Matches documented "aggregate on read"; BACKLOG revisit trigger only at tens of thousands of orders per customer. |
| Permission-gated sections vanishing looks like a bug | Intended RBAC behaviour; matches the existing `getLoyaltySummary` degradation idiom. Documented in-code and in the architecture doc. |
| Refund↔customer join correctness (`refunds` has no `customer_id`) | Join via `order.customerId`; covered by an explicit per-customer refund test. |
| Scope creep toward a CRM dashboard | Explicitly out of scope; segments already live in Marketing → Segments. |
| Frontend/backend type drift on the extended response | Shared `api.ts` types extended in the same change; typecheck gate catches drift. |

---

## 11. Acceptance criteria

**Functional**
- Opening a customer shows **intelligence cards**: LTV, Avg spend, Visit
  frequency, Last visit, Segment, and Tier (Tier present when loyalty visible).
- **Loyalty** section shows balance, tier, progress to next tier, and recent
  points entries for `loyalty.read` users; absent (no error) otherwise.
- **Favorite items** lists top 5 by quantity from non-void orders; absent when
  the customer has none.
- **Refunds** shows total returned + a recent list only when `count > 0`.
- **Recent activity** shows this customer's audit events plus a Timeline link
  for `audit.read` users; absent otherwise.
- Existing spend stats, order history, notes, edit, CSV export, and the
  customer list remain unchanged.

**Integrity / non-functional**
- Every figure is server-derived; voided/cancelled orders excluded from spend
  and favorite items; refunds counted as-is.
- No new table or endpoint (beyond the `entityId` filter); no cached counters.
- Segment resolved only via the shared classifier; loyalty only via
  `LoyaltyService`.
- RLS holds — cross-tenant rows are never returned (test-proven).
- lint, typecheck, build, unit + e2e green; manual browser verification done.

---

## 12. Out of scope (YAGNI) & future recommendations

- **At-risk (distinct from Lapsed)** — a "was-regular, now-slipping" cadence
  signal. `LAPSED` + the win-back recommendation already cover the actionable
  case; add a finer model only when an owner asks.
- **Per-restaurant segment thresholds** — currently constants; a settings
  concern for later.
- **Cached LTV / cohort retention / materialized views** — the architecture
  forbids caches and background jobs without evidence; add only under measured
  load.
- **No** separate CRM dashboard, **no** duplicated history, **no** client-side
  financial calculation.
