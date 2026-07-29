# Event & Activity Infrastructure

The reference for how OraOS records "something happened." Read this before you
add any logging, audit trail, or history to a feature.

## TL;DR for a feature author

Inside a `prisma.tx(...)` block, call the shared writer:

```ts
await this.events.record(db, {
  action: 'order.voided',      // '<entity>.<verb>'
  entityType: 'order',
  entityId: order.id,          // optional
  metadata: { orderNumber, reason }, // optional, non-sensitive
});
```

That is the whole public API. You never pass the actor or the tenant — they are
derived from the request context. You never call `db.auditLog.create(...)`
directly (the two deliberate exceptions are named at the end).

## The three event stores, and why they are separate

OraOS deliberately keeps three append-only stores rather than one god-table.
They answer different questions, have different owners, and — critically — live
under different security boundaries.

### `audit_logs` — "what happened inside this restaurant?"

Tenant-scoped. Every meaningful action a user takes within a restaurant:
`order.voided`, `order.refunded`, `order.discounted`, `staff.invited`,
`staff.deactivated`, `restaurant.updated`, … Columns:

| column | meaning |
| --- | --- |
| `restaurant_id` | the tenant (from context, never input) |
| `user_id` | the actor (from context; nullable for system actions) |
| `action` | `'<entity>.<verb>'`, a stable string |
| `entity_type` / `entity_id` | what was acted on |
| `metadata` (jsonb) | structured, non-sensitive detail |
| `created_at` | when |

It is indexed for the two reads it actually serves: a tenant timeline
(`restaurant_id, created_at`) and an entity's history
(`restaurant_id, entity_type, entity_id`). **This is the generic activity
stream** every future read-model builds on. `EventsService` writes here.

### `security_events` — "what happened to this identity?"

Global, **not** tenant-scoped: login, logout, token rotation, reuse detection,
password reset, email verification. These happen *before* a tenant context can
exist (you cannot know which restaurant a login belongs to until it succeeds),
so they cannot live in a tenant-scoped table. Making `audit_logs.restaurant_id`
nullable to fit them here would punch a hole in the RLS policy that is the
system's primary security boundary — a second table is cheaper than a weakened
boundary.

Written by `SecurityEventService.record(...)`, which is **fire-and-forget** (its
own transaction, never throws): an auth-trail write must never be able to fail a
login. That is the opposite contract from `EventsService` (below), and the
reason they are different services. **Do not route auth events through
`EventsService`, and do not modify `SecurityEventService` to look like it.**

### `order_events` — the order's own timeline

Tenant-scoped, but a **typed domain projection**, not a generic log: it has a
`type` enum (`CREATED`, `STATUS_CHANGED`, `PAYMENT_RECORDED`, …) plus
`from_status` / `to_status` columns that the order-timeline UI and the voids
report read directly. Forcing it through a stringly-typed generic `record()`
would throw away that type safety for no gain. It stays as-is, written inline in
`OrdersService`. A void or refund is recorded in **both** `order_events` (the
order's timeline) and `audit_logs` (the owner's cross-cutting review) — that
duplication is intentional; they are read by different screens.

### Why we did NOT create a new `events` table

The tempting maximalist move — one canonical `events` table that everything
funnels into — was considered and rejected for this milestone:

- `audit_logs` **already is** that table for tenant actions. Its shape
  (`action` / `entity_type` / `entity_id` / `metadata` / actor / tenant / time)
  is exactly a generic activity record, already append-only, already RLS-scoped,
  already correctly indexed.
- A new table would mean a migration, a backfill decision, two overlapping
  tables answering the same query, and re-pointing the existing audit reader —
  churn with no functional gain today.
- The genuinely missing piece was never storage. It was a **single write path**,
  so features stop hand-rolling `auditLog.create` and re-deriving actor/tenant.
  That is what `EventsService` adds, and nothing more.

If a future feature proves it needs a superset table (e.g. cross-tenant system
events, or a partitioned high-volume stream), it can be introduced then, behind
the same `EventsService` seam, without touching a single caller.

## Rules the writer enforces

### Transaction rules

`record(db, input)` takes the **caller's transaction client** and writes with
it. The event therefore commits — or rolls back — atomically with the business
change that produced it. This is the point: **there must be no audit row for a
change that never committed.** If the surrounding `prisma.tx(...)` throws after
the event is recorded, the event is discarded with everything else.

This is deliberately **not** fire-and-forget. `SecurityEventService` is
fire-and-forget because the auth path must survive a logging failure; a tenant
audit trail is the opposite — losing the record of a change that *did* happen is
the failure.

### RLS rules

The write happens inside `prisma.tx(...)`, which sets `app.restaurant_id` and
`app.user_id` LOCAL to the transaction. The `audit_logs` RLS policy's
`WITH CHECK (restaurant_id = current_restaurant_id())` then verifies the row's
tenant against that setting. `record()` sources `restaurant_id` from the same
context, so the check always passes for a legitimate write and always fails for
a cross-tenant one. **Actor and tenant are never accepted from the caller** —
the same rule the whole codebase applies to `restaurant_id`. A missing tenant
context throws (fail-closed), rolling the transaction back.

### Append-only behaviour

`audit_logs` has a `BEFORE UPDATE OR DELETE` trigger (`reject_mutation`) that
raises on any mutation. Rows can only ever be inserted. `record()` only inserts,
so it is unaffected; any code that tries to "correct" an event by updating it
will be rejected by the database. Correct history by appending a new event,
never by editing an old one.

## When to call `EventsService.record()`

Call it for **any tenant action worth remembering** — anything a future
timeline, audit view, customer history, or analytic might want to show or count.
Cheap to add, and adding it early is what makes those features possible without
re-instrumenting the codebase later.

Do **not** call it for:

- **Auth/identity events** → `SecurityEventService`.
- **Order lifecycle transitions** that belong on the order's own timeline →
  `order_events` (in `OrdersService`).
- **Domain ledgers** with their own semantics — stock, cash, attendance,
  refunds, coupon redemptions. Those are purpose-built append-only tables, not
  generic events; keep writing them directly.

## What must NEVER be logged

`metadata` is read by the audit UI today and by more surfaces tomorrow. Never
put in it:

- secrets or tokens (JWTs, refresh tokens, invite/reset tokens, API keys);
- passwords or password hashes;
- full card data (PAN/CVV) or equivalent payment credentials;
- more PII than the action needs — prefer ids and short labels over copying a
  customer's full record into every event.

Keep `metadata` to ids, amounts (minor units), enums, and short reasons.

## Bootstrap writes — the two deliberate exceptions

Two paths write `audit_logs` directly instead of via `EventsService`, because
their actor/tenant **predate the request context** that `record()` derives from:

1. **`restaurant.created`** (`RestaurantsService`): runs in `txAs()` with a
   client-generated tenant id that does not yet exist in the request context
   (the creator has no membership until the same transaction creates it).
2. **`staff.joined`** (`StaffService.acceptInvite`): the public `/join` route
   has no request context, and the actor is the user being *created* on that
   line, not a logged-in caller.

Both are commented at the call site pointing here. They are the reason
`record()` does not offer an actor/tenant override — the escape hatch for these
rare bootstrap cases is the raw model call, which keeps the safe default (context
-derived, un-overridable) honest for the 99% path.

## Future features this enables

Everything below reads from the stores above; none of it changes the write path:

- **Restaurant Timeline** — a merged, chronological view over `audit_logs`
  (+ optionally `order_events`) for a tenant.
- **Customer History** — `audit_logs` filtered by `entity_type = 'customer'`
  (plus orders), once customer actions are recorded through `record()`.
- **Analytics** — counts and rates over `action` / `created_at`.
- **Notifications** — a consumer that reacts to certain actions (a post-commit
  emit hook can be added behind `EventsService` without touching callers).
- **AI Assistant** — a natural-language surface over the same activity stream.
- **Loyalty** — derived from order and customer events.

Add typed wrappers (`recordOrderEvent(...)`, etc.) only when real usage proves
they earn their keep; they will wrap `record()` and require no caller changes.
