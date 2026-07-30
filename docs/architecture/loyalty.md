# Loyalty Foundation

The reference for how OraOS records and derives loyalty points. Read this before
you build anything on top of points — rewards, coupons, cashback, referrals,
birthday offers. They all read this ledger; none of them re-implement it.

This is a **financial subsystem**, not a marketing feature. It gets the same
discipline as money: an append-only ledger, no mutable balance, tenant
isolation by RLS, and every movement traceable.

## TL;DR for a feature author

Points live in one append-only table, `loyalty_ledger`. A customer's balance is
the **sum of their rows** — there is no balance column to read or to drift. Move
points only through `LoyaltyService`:

```ts
await loyalty.earnForOrder(orderId);        // credit a sale's points, once
await loyalty.reverseForOrder(orderId);     // claw them back on a refund, once
await loyalty.redeem(customerId, { points });          // spend, never below zero
await loyalty.adjust(customerId, { points, reason });  // manual ±, never below zero
const summary = await loyalty.getSummary(customerId);  // balance, tier, history
```

You never write `db.loyaltyLedger.create(...)` from another module, and you
never store a balance anywhere. If you need the balance, sum the ledger (the
service already does).

## Why a ledger, not a balance

The obvious design — an integer `points` column on `customers`, incremented on
earn and decremented on redeem — is the wrong one, for the same reasons this
codebase already refuses it for stock (`StockMovement`, no `quantity` on
`Ingredient`) and for customer spend (`Customer`, no cached `totalSpent`):

- **A counter is a lie the moment two tills touch it.** Two concurrent redeems
  that both read `100` and both write `100 - 30` leave `70`, not `40`. A ledger
  makes concurrent writes correct by construction: each is an independent
  `INSERT`, and the balance is whatever the rows sum to.
- **A counter throws away the only question a dispute asks.** Not "how many
  points" but "where did they come from, and where did they go." A ledger is
  that answer. A counter is a number with no story.
- **A counter cannot be audited.** You cannot prove a balance is correct if the
  only evidence is the balance itself. A ledger is self-proving: recompute the
  sum and compare.

So the ledger is the source of truth, and it is **append-only, enforced by a
trigger** (`loyalty_ledger_append_only`) — the same `reject_mutation()` trigger
that guards `audit_logs`, `order_events`, `refunds` and the stock ledger. A
mistake is corrected by appending an opposing row (an `ADJUST`, a
`REFUND_REVERSAL`), never by editing history. `UPDATE` and `DELETE` are revoked
from the application role on top of the trigger, belt and suspenders.

## The ledger

One row per points movement. `points` is a **signed integer** — points are
whole numbers, held to the same integer discipline as money (paise), never a
float.

| column | meaning |
| --- | --- |
| `restaurant_id` | tenant (from context, never input); RLS keys on it |
| `customer_id` | whose points these are (FK, `RESTRICT` — history outlives no one quietly) |
| `type` | `EARN` · `REDEEM` · `ADJUST` · `REFUND_REVERSAL` · `EXPIRE` |
| `points` | signed; sign tied to `type` by a `CHECK` |
| `order_id` | the sale that earned/reversed these points; null for manual moves. **No FK** — a ledger row outlives any order tidy-up |
| `reason` | why (required for a manual `ADJUST`) |
| `actor_user_id` | who performed a manual move (no FK, outlives the account) |
| `idempotency_key` | client-supplied; a retried redeem/adjust cannot double-apply |
| `created_at` | when |

**Sign convention** (a `CHECK` enforces it, so a wrong-signed write fails at the
source): `EARN`, `REDEEM_REVERSAL` and a positive `ADJUST` credit (`> 0`);
`REDEEM`, `EXPIRE`, `REFUND_REVERSAL` and a negative `ADJUST` debit (`< 0`).

### The six entry types

- **EARN** — points for a sale. Computed by the rules engine from the order's
  net spend. One per order, guaranteed by a partial unique index on
  `(restaurant_id, order_id, type)`.
- **REDEEM** — points the customer spent — at the counter, or as a checkout
  discount (M11, an order-tied `REDEEM`). Debited under a lock so it can never
  overspend.
- **ADJUST** — a manual signed correction or goodwill grant. Reason mandatory.
- **REFUND_REVERSAL** — points clawed back when the sale that earned them is
  refunded. One per order. The single entry allowed to push a balance negative.
- **REDEEM_REVERSAL** — points restored when a refunded sale's redemption is
  unwound (M11). Positive, one per order, and deliberately NOT a status type: it
  moves the spendable balance without touching lifetime-earned or tier — the
  symmetric counterpart to `REFUND_REVERSAL`.
- **EXPIRE** — points lapsing after inactivity. The type and its maths exist so
  nothing downstream has to change when expiry ships; **no expiry job runs yet.**

## How balances are calculated

Everything is derived from one grouped sum (`GROUP BY type`) plus a recent-rows
read — two queries, no N+1, no per-customer loop:

- **`balancePoints`** = `SUM(points)` over all of a customer's rows. What is
  spendable right now.
- **`lifetimeEarnedPoints`** = `SUM(points)` over the *status* types — `EARN`,
  `REFUND_REVERSAL`, `ADJUST`. Redeeming and expiring are excluded, so spending
  points never costs a customer their tier, while a refund correctly walks it
  back.
- **`redeemedPoints`** = `-SUM(points)` over `REDEEM`.

The `(restaurant_id, customer_id, created_at)` index serves both the sum and the
history read. A customer's ledger is small (their own visits), so the sum is a
millisecond operation; there is no balance to cache and therefore no cache to
go stale. If a tenant ever grows a customer to millions of entries, the
documented next step is a periodic rollup row — never a mutable live counter.

## How tiers work

Tier is a **pure function of `lifetimeEarnedPoints`** (`loyalty.rules.ts`,
`tierFor`). The ladder is code-defined for the foundation:

| tier | lifetime points |
| --- | --- |
| Bronze | 0 |
| Silver | 1,000 |
| Gold | 5,000 |
| Platinum | 20,000 |

Because tier follows *lifetime earned* rather than the current balance, a
customer who spends their points keeps their status — which is the whole point
of status. The summary also returns `nextTier` and how many points away it is.

Per-tenant tier ladders are a deliberate non-goal for the foundation (that is a
configuration/marketing concern). When they arrive, `TIERS` becomes a table read
and `tierFor` its only caller to change — no consumer of the summary is affected.

## The rules engine

`loyalty.rules.ts` is the **policy**, isolated from the ledger **mechanism**.
Every function is pure — no database, no request context — so a future milestone
can change earning or tiers without touching how points are stored:

- `pointsForOrder(order)` — points from **net spend** (`subtotal − discount`),
  tax excluded (a customer is rewarded for what they spent, not for the GST the
  restaurant collects). Integer floor, so points never outrun value. Default:
  1 point per ₹10. A checkout redemption is a discount, so it lowers the net and
  thus the earn — consistent with coupons.
- `redemptionFor(points, subtotal)` — the ₹ discount that redeeming `points`
  funds at **1 point = ₹1**, capped so it can never exceed the subtotal (M11).
  Pure; the caller enforces the balance under a lock.
- `tierFor` / `nextTierFor` — the ladder, above.

This is intentionally a **seam, not a rules DSL or a rules table.** The
foundation needs one earn rule and one tier ladder expressed in one testable
place; a pluggable engine with no second rule to plug in would be speculation.
When bonus multipliers, category rules or campaigns arrive, they extend this
module; callers keep depending only on its functions.

## Financial integrity

Two invariants are enforced in the service rather than the schema, because a
*derived* balance has no column to constrain:

1. **No negative balance.** `redeem` and a negative `adjust` take a
   `SELECT … FOR UPDATE` lock on the customer row, then read the balance and
   refuse to overspend. The lock **serializes concurrent moves for one
   customer**, so two tills cannot both spend the last 100 points — exactly one
   wins, the other sees a zero balance and is refused. (Verified by an e2e that
   fires two redemptions at once and asserts the balance never goes below zero.)
2. **Idempotency.** `earn`/`reverse` are unique per `(order, type)` at the
   database; `redeem`/`adjust` carry a client key unique per tenant. A constraint
   violation aborts the Postgres transaction, so — exactly as
   `OrdersService.recordPayment` does — the unique race is caught **outside** the
   transaction and answered with a fresh read of the summary, never a second row.

`REFUND_REVERSAL` is the one move allowed to drive a balance negative: a customer
may already have spent points that a refund now unwinds, and the honest record
of that is a negative balance, not a suppressed one.

## Security

- **Tenant isolation** is RLS, like every tenant-scoped table: the policy keys on
  `restaurant_id = current_restaurant_id()`, set per transaction from the JWT.
  No query names a `restaurantId`; RLS applies it and cannot be forgotten.
- **Authorization** is permission-based (`PermissionsGuard`):
  `loyalty.read` to view, `loyalty.redeem` to spend (the cashier, at the till),
  `loyalty.adjust` to award/correct/reverse (a manager — a money-adjacent
  action). Owner holds all; kitchen holds none.
- **Actor and tenant are never client input** — both come from the verified
  token, the same rule the whole codebase applies.
- **Events**: every movement records a `loyalty.*` audit event through the M0
  `EventsService`, atomically inside the same transaction, carrying ids and
  amounts but no PII. Timeline and Customer History will read these.

## API

All routes are permissioned and tenant-scoped. `earn`/`reverse` are exposed as
explicit endpoints so the foundation is complete and testable on its own.
**Smart Checkout (M10) now calls these same `LoyaltyService` methods
automatically** from the payment and refund flow — post-commit and best-effort,
so a loyalty failure never rolls back the money — and the endpoints remain the
idempotent manual-recovery path.

| method & path | permission | does |
| --- | --- | --- |
| `GET /customers/:id/loyalty` | `loyalty.read` | balance, lifetime, tier, next tier, recent entries |
| `POST /customers/:id/loyalty/redeem` | `loyalty.redeem` | spend points (`{ points, reason?, idempotencyKey? }`) |
| `POST /customers/:id/loyalty/adjust` | `loyalty.adjust` | manual ± (`{ points, reason, idempotencyKey? }`) |
| `POST /orders/:id/loyalty/earn` | `loyalty.adjust` | credit a sale's points, idempotent |
| `POST /orders/:id/loyalty/reverse` | `loyalty.adjust` | reverse a sale's points, idempotent |

## What this milestone deliberately does not do

- **Checkout/refund wiring — added later in M10.** The foundation shipped without
  it: earning and reversal ran only via the manual endpoints. Smart Checkout
  (M10) wired them into the payment/refund flow (`OrdersService`, post-commit,
  best-effort) without changing the ledger or these methods.
- **No expiry job and no per-tenant tiers.** (Redemption→discount at checkout —
  once listed here as not-done — shipped in M11; auto earn/reverse in M10.) The
  foundation exposed the data; the integrations that surface and spend it arrived
  in the later milestones.

## Future extensions (foundation designed for, not built)

- **Auto-earn / auto-reverse** wired into checkout and refunds — **done in M10.**
- **Per-tenant tier ladders** — `TIERS` becomes a `loyalty_tiers` table.
- **Expiry** — a scheduled job appends `EXPIRE` rows; the maths already excludes
  them from tier and includes them in balance.
- **Redemption value** — points → discount conversion at checkout — **done in
  M11** (`redemptionFor`, an order-tied `REDEEM`, and `REDEEM_REVERSAL` on refund).
- **Rollup rows** for customers with very large ledgers, if a tenant ever needs
  them. A rollup is a summarizing ledger row, still append-only — never a
  mutable counter.
- **Richer rules** — bonus multipliers, category/time rules, campaigns — all
  extend `loyalty.rules.ts` behind its existing function boundaries.
