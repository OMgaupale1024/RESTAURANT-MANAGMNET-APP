# Restaurant Timeline

The one operational history of a restaurant — "what happened today, who did it,
when, and to which order or customer." Read this before adding a source to the
Timeline or changing how activity is recorded.

## What it is

A **read view over the append-only `audit_logs` table** — nothing more. It
introduces no store, no table, no second copy of anything. Milestone 0 built
`EventsService.record` precisely so that "something happened in this restaurant"
is written **once**, in the caller's transaction, to one RLS-protected,
append-only table; the Timeline is the first feature to read it back
(`docs/architecture/events.md`). Every future reader (Customer History,
Analytics) reads the same table the same way.

- API: `GET /reports/audit` (`ReportsService.auditLog`), `audit.read` only.
- Web: `apps/web/src/app/dashboard/audit/audit-client.tsx` (route kept at
  `/dashboard/audit`; the nav label is **Timeline**).

## Why there is no new event store

The instinct for a "timeline" is a generic `activity` table that every feature
writes to. We already have that table — it is `audit_logs`, written through the
M0 seam. A second one would mean **double-writing** every event and keeping two
schemas in sync forever. Worse, a naïve "merge every ledger into one feed" would
**double-count**: `order.voided` is already an `audit_logs` row *and* an
`order_events` `STATUS_CHANGED` row; loyalty is an `audit_logs` row *and* a
`loyalty_ledger` row. The Timeline reads the one table that already holds the
deduplicated, notable business events. This is the whole point of the milestone:
expose history, do not invent a new way to store it.

## Data sources

Everything the Timeline shows is an `audit_logs` row written by
`EventsService.record`. Today that is:

| Category | Actions | entityId links to |
| --- | --- | --- |
| Orders | `order.discounted`, `order.voided` | the order |
| Refunds | `order.refunded` | the order |
| Customers | `customer.created` | the customer |
| Loyalty | `loyalty.earned` · `redeemed` · `adjusted` · `refund_reversed` | the customer |
| Staff | `staff.invited` · `invite_revoked` · `joined` · `updated` · `deactivated` | the invite / membership |
| Settings | `restaurant.created` · `restaurant.updated` | the restaurant |

New event types need **no Timeline change** — they appear automatically. Only
the human label (`ACTION_LABEL`) and, if it should filter as a new category, the
category maps (client `categoryOf` + server `CATEGORY_ACTION`) are worth adding.

## What stays in its own ledger, and why

The audit deliberately did **not** pull these into the feed:

- **Kitchen / order lifecycle** (`order_events`) — every `PLACED → PREPARING →
  READY → COMPLETED` tick. Per-order granularity belongs on the order detail and
  the KDS; surfacing it here would bury the owner in noise **and** double-count
  the void/refund rows that are already in `audit_logs`. The *notable* order
  events (void, refund, discount) are what reach the Timeline.
- **Inventory** (`stock_movements`) — its own append-only ledger with its own
  screen and its own "auditor's view". Not evented into `audit_logs`.
- **Cash / day-close** (`cash_movements`, `cash_sessions`) — reconciliation
  lives on Day Close.
- **Attendance** (`attendance_events`) — an HR ledger, not operations.
- **Security / auth** (`security_events`) — logins, password resets, token-reuse
  detection. A **separate trust boundary**: written fire-and-forget by
  `SecurityEventService` (not tenant-transactional), keyed differently, and read
  through a security lens, not an operations one. The operational "who removed
  access / reversed money" need is already met by the `staff.*` and
  `order.voided` / `order.refunded` rows that *are* in `audit_logs`.

The rule: a source joins the Timeline only when it flows through the M0 event
seam. If it should, the fix is to `record` it at the source — never to teach the
Timeline to read a second table.

## Filtering & performance

All filters are query params on the one endpoint; there are no client-side
joins and no N+1:

- **Category** — the client sends a label (`orders`, `refunds`, …); the server
  maps it to an `action` prefix (`CATEGORY_ACTION`). One indexed predicate.
- **Date** — `from`/`to` as inclusive IST days (Today · Yesterday · 7 days · All
  presets today; the endpoint already accepts an arbitrary range).
- **Search** — `q`, a case-insensitive `contains` over `action` + `entityType`.
- **Pagination** — **keyset** by id (`id < cursor`), UUIDv7 being time-ordered,
  so paging is O(limit) at any depth and composes with every filter. The
  `(restaurant_id, created_at)` index backs the ordered scan.
- **Actor names** — resolved in **one** `membership.findMany` per page (not per
  row), mapped in memory. Membership is RLS-scoped, so a name can only ever be a
  staff member of the current restaurant.

The feed is grouped into Today / Yesterday / date sections on the client from
the already-ordered rows — no extra request.

## Permission model

- `audit.read` only — seeded to **OWNER** and **MANAGER** (the anti-theft
  record; a cashier cannot pull it). Enforced by `@RequirePermissions` +
  `PermissionsGuard`; the nav link is hidden for other roles as UX only.
- **RLS is the real boundary.** Every read runs inside `prisma.tx`, scoped to
  `app.restaurant_id`; the Timeline can only ever show the caller's own tenant.
- **No new exposure.** Every field shown is one the same user could already
  read: the audit row (they have `audit.read`), the actor's name (visible on
  Staff), and the linked order/customer (their existing detail views). Metadata
  is ids, amounts and short labels only — the event seam forbids PII/secrets.

## Detail experience

A row is a **link to the existing detail view**, never a duplicated page: order
and refund rows open `/dashboard/orders?id=…`; customer and loyalty rows open
`/dashboard/customers?id=…` (both via the pages' `?id=` deep link). Staff and
settings rows have no per-row profile page and are not linked.

## Future integrations (not built)

- **Custom date-range picker** — the endpoint already takes arbitrary `from`/`to`;
  only the preset UI ships today.
- **Metadata search** — `q` covers action/entity type; searching by order number
  or reason means a `metadata::text` predicate (raw SQL), deferred until asked.
- **Realtime prepend** — the per-tenant socket already emits on order events;
  the Timeline could subscribe and prepend without a refetch. Deferred (a
  history screen is not a live board).
- **Bringing a ledger in** — if kitchen/inventory/cash activity should ever
  appear, route it through `EventsService.record` at the source (with a new
  category), so it lands in the one table — never a second read path here.
