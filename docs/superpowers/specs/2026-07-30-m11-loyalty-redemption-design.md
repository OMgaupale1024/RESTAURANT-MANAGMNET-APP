# M11 — Loyalty Redemption — Design Document

**Status:** Proposed (awaiting approval)
**Date:** 2026-07-30
**Scope:** aligned after the M11 architecture audit — spend loyalty points as a
server-computed discount at checkout, atomic with the sale; re-credit them on a
refund. Rate **1 pt = ₹1**; redemption is **exclusive** with coupon/manual;
refund re-credit is **in scope**.

> M10 earned and reversed points as a *consequence* of settlement (post-commit,
> best-effort). Redemption is the opposite kind of thing: the points **fund a
> discount that is part of the bill**, so the spend must be **atomic with the
> order** — the same shape coupons already have. This milestone reuses the
> coupon discount pattern and extends the loyalty seam; it does not invent a new
> discount mechanism.

---

## 1. Objectives

1. **Let a customer pay part of a bill with points** — the cashier redeems N
   points for a ₹N discount at checkout, computed and enforced server-side.
2. **Atomic with the sale.** The point-spend and the discount commit together or
   not at all — never a discount without the debit, never a debit without the
   sale.
3. **Correct on refund.** Refunding a redemption order restores the spent points
   **without** distorting lifetime-earned or tier.
4. **Reuse, don't reinvent.** Mirror the coupon discount pattern; extend the
   existing `REDEEM` seam and rules engine; touch the schema only where refund
   re-credit provably requires it.
5. **Ship safely:** tests, docs, roadmap, no regressions, manual + live
   verification before commit.

### Alignment with engineering principles

| Principle | How this design honours it |
|---|---|
| Audit first | Full audit done: redeem seam, order money model + CHECKs, coupon pattern, refund path all traced before design. |
| Reuse before creating | Coupon in-tx discount pattern, `REDEEM` type + `order_id` column, customer-row lock, events/Timeline/Analytics, POS discount UI, M10 receipt block — all reused. |
| Extend before rewriting | `redeem` mechanism made tx-injectable; `reverseLoyalty` extended to also restore redemptions. One new rules constant. |
| Single source of truth | Discount computed once server-side inside the order tx; redeemed points read back from the ledger (never client rate-math). |
| Server-authoritative | Client sends *points to redeem*, never an amount; the server caps and computes the discount and the debit. |
| No duplicated business logic | The rate lives once in `loyalty.rules.ts`; the discount identity stays the one DB CHECK. |
| Minimal footprint | No new table, no new endpoint, no cache, no worker. **One** deliberate schema change: a `REDEEM_REVERSAL` enum value (justified in §4.1). |

---

## 2. Architecture overview

Redemption is a **third discount source** alongside coupon and manual — and like
them it is **computed and recorded inside the order-creation transaction**:

```
create(order, redeemPoints)                       ┌ one order transaction ┐
  price items → subtotal                          │                       │
  discount source (exactly one):                  │                       │
    coupon  → validateAndComputeDiscount(db,…)     │  atomic: the discount │
    manual  → capped ad-hoc amount                 │  AND its record AND   │
    redeem  → redeemForOrder(db, cust, pts, sub) ──┤  the REDEEM debit all │
  total = subtotal − discount + tax  (DB CHECK)    │  commit together      │
  insert order (+ payment/stock as today)          │                       │
  append REDEEM ledger row (order_id, −pts)  ──────┘                       ┘
        │
        └─ (post-commit, M10) creditLoyalty → earns on the REDUCED net
```

```
recordRefund(order)                          ┌ financial tx commits ┐
  insert refund (money out)                  └──────────────────────┘
        │
        └─ (post-commit, best-effort — M10 pattern, extended)
             reverseLoyalty(order):
               reverseForOrder        → REFUND_REVERSAL of the EARN   (existing)
               restoreRedeemedForOrder→ REDEEM_REVERSAL of the REDEEM (new, §4.1)
```

Two properties, mirroring what the codebase already does:

- **Redemption is atomic (like coupons).** It cannot be post-commit: the ₹N is
  on the bill. It runs in the order tx, under the customer-row `FOR UPDATE` lock
  that `redeem` already uses, so two concurrent orders can't overspend the same
  points. Idempotency is the **order's** existing key — a replayed create returns
  the original order, so the `REDEEM` never doubles.
- **Refund re-credit is a consequence (like M10's earn-reversal).** It runs
  post-commit, best-effort, idempotent per `(order, REDEEM_REVERSAL)` — a loyalty
  hiccup can never fail a refund.

---

## 3. Existing systems to reuse

- **Coupon discount pattern** — `MarketingService.validateAndComputeDiscount(db,…)`
  + `recordRedemption(db,…)`: the template. Compute the discount in-tx, cap it,
  append an immutable record, put the amount in `discountMinor`. Redemption is
  the same shape.
- **`REDEEM` ledger type + `loyalty_ledger.order_id`** (nullable, currently null
  for redeems) — a checkout redemption sets `order_id`; **no schema change for
  the redeem itself.**
- **`LoyaltyService` internals** — `lockCustomer` (the `FOR UPDATE` serialization),
  `balance`, `append` (writes the row + the `loyalty.redeemed` event). Reused via
  a tx-injectable method (§4.2).
- **Order money model + CHECKs** — `total = subtotal − discount + tax`,
  `discount ≤ subtotal` (the last-line guardrail; redemption never bypasses it).
- **M10 `reverseLoyalty` post-commit seam** in `recordRefund` — extended to also
  restore redemptions.
- **Events / Timeline / Analytics** — `loyalty.redeemed` already fires from
  `append`; Analytics `loyaltyStats` already sums `REDEEM`. Checkout redemptions
  flow in with **zero change** (same as M10).
- **POS discount UI** (`discountFields`: coupon XOR manual) and the **M10/M3
  receipt loyalty block** + `earnedForOrder` — the homes for a redemption control
  and a "Redeemed −₹X" line, via a sibling `redeemedForOrder(loyalty, orderId)`.

---

## 4. Components/services to extend

### 4.1 Schema — one new enum value: `REDEEM_REVERSAL` (the only migration)

Refund re-credit **requires** a positive, balance-only, **non-status** entry:
restoring spent points must raise the balance **without** raising
lifetime-earned/tier (the original `REDEEM` never lowered them, so undoing it
must not raise them). No existing type is both positive and non-status, so:

- Add `REDEEM_REVERSAL` to `LoyaltyEntryType`.
- Sign CHECK: `REDEEM_REVERSAL ⇒ points > 0` (a credit).
- **Included in balance** (all types sum), **excluded from `STATUS_TYPES`** — so
  it moves the spendable balance only, exactly like `REDEEM` in reverse.
- Idempotent per `(restaurant_id, order_id, REDEEM_REVERSAL)` — the same partial
  unique index shape `EARN`/`REFUND_REVERSAL` already use.

This is **symmetric with `REFUND_REVERSAL`** (which M2 added for earn-reversal):
the ledger already models "a refund unwinds a movement" as a typed opposing
entry. Rejected alternatives: a positive `ADJUST` (in `STATUS_TYPES` → wrongly
inflates tier over redeem/refund churn); editing the `REDEEM` (append-only,
forbidden). This is the milestone's single schema touch.

### 4.2 `loyalty.rules.ts` — the rate + a pure cap helper

- `REDEEM_RATE_MINOR_PER_POINT = 100` (**1 pt = ₹1**). Sits beside `EARN_RATE`,
  same rules-engine seam.
- `redemptionFor({ points, balancePoints, subtotalMinor })` → `{ points,
  discountMinor }`: pure. Caps the redeemable points at
  `min(requested, balance, floor(subtotal / RATE))` so the discount never wastes
  points and never exceeds the subtotal; `discountMinor = points × RATE`.

### 4.3 `LoyaltyService` — tx-injectable redeem + refund restore

- **`redeemForOrder(db, customerId, orderId, points)`** — runs **inside the
  caller's order tx**: takes the customer `FOR UPDATE` lock, reads balance,
  refuses to overspend, appends a `REDEEM` row (`order_id` set, `points` negative)
  + the `loyalty.redeemed` event. Extends the existing `redeem` mechanism to be
  tx-injectable, exactly as `validateAndComputeDiscount` is for coupons. (The
  standalone `redeem()` endpoint is unchanged.)
- **`restoreRedeemedForOrder(orderId)`** — post-commit sibling of
  `reverseForOrder`: finds the order's `REDEEM`, appends `REDEEM_REVERSAL`
  (`+points`) once, idempotent; `NotFound`/no-redeem is a benign no-op.

### 4.4 `OrdersService`

- **`insert()`** — redemption becomes a third discount branch, **mutually
  exclusive** with coupon and manual. When `dto.redeemPoints`:
  requires `dto.customerId` (a loyalty account) and the `loyalty.redeem`
  permission (checked in `create()`, like `order.discount` gates manual);
  rejected on a held order (a hold takes no money — like `hold + paymentMethod`);
  `discountMinor` is computed via `redemptionFor` under the lock, and the
  `REDEEM` is appended in-tx after the order row exists (so `order_id` is real).
- **`recordRefund()` post-commit** — `reverseLoyalty(orderId)` now calls both
  `reverseForOrder` (earn) **and** `restoreRedeemedForOrder` (redeem), each
  swallowed/idempotent. Any refund restores **all** redeemed points once
  (non-proportional — symmetric with M10's earn-reversal ceiling).

### 4.5 `create-order.dto.ts`

- Add `redeemPoints?: number` (`@IsInt @Min(1) @Max(MAX_POINTS)`), documented as
  "points to spend; the server caps and computes the ₹ discount — the client
  never sends an amount."

---

## 5. API changes

| Endpoint | Change |
|---|---|
| `POST /orders` | Accepts optional `redeemPoints`. Server caps and computes the discount into `discountMinor`; exclusive with `couponCode`/`manualDiscountMinor`. Response shape **unchanged** (`discountMinor`/`totalMinor` already carry it). |
| `GET /customers/:id/loyalty` | **No change** — already returns balance + `recentEntries` (the `REDEEM`/`REDEEM_REVERSAL` rows). |

**No new endpoint.** The POS derives "N points redeemed" from the loyalty
summary's `REDEEM` entry for the order (a `redeemedForOrder(loyalty, orderId)`
helper mirroring M10's `earnedForOrder`) — **server-derived, no client rate
math.** `api.ts` gains the `redeemPoints` field + the helper.

---

## 6. Data flow

```
POS: customer attached → getLoyaltySummary → show "Balance N pts (₹N)"
     cashier enters "redeem P points" → client preview P×₹1 (server is authoritative)
        │
        ▼
createOrder({ items, customerId, redeemPoints: P })          [order.create + loyalty.redeem]
   OrdersService.insert (one tx):
     subtotal S; redemption = redemptionFor(P, balance, S) → { p, discount }
     order.discountMinor = discount;  total = S − discount + tax   (CHECK)
     insert order → redeemForOrder(db, cust, order.id, p)  → −p REDEEM (order_id), loyalty.redeemed
   commit
        │
        └─ (post-commit, M10) creditLoyalty → earns floor((S − discount)/₹10)   [earn on net]

POS success panel / bill:  Redeemed −₹p   ·   Earned +E   ·   Balance …
   (redeemedForOrder + earnedForOrder, both read back from the ledger)
```

```
recordRefund(order) → commit → reverseLoyalty:
     reverseForOrder         → REFUND_REVERSAL −E     (idempotent)
     restoreRedeemedForOrder → REDEEM_REVERSAL +p     (idempotent)
   → balance restored, tier unaffected by the redeem/restore pair
```

---

## 7. UI/UX changes — POS + receipt

1. **Redemption control** in the cart panel, beside coupon/discount. Enabled only
   when a customer is attached **and** the caller has `loyalty.read` (to show the
   balance) and `loyalty.redeem`. Shows "Balance N pts · up to ₹M on this order"
   and a points input; previews the discount (`P × ₹1`, client-side, server
   authoritative) and the new total. Mutually exclusive with coupon/manual in the
   UI (matches the server rule and the existing coupon/manual exclusivity).
2. **Fetch loyalty on customer-attach** — POS already fetches the summary on the
   success panel (M10); extend the same best-effort fetch to *customer-attach* so
   the redemption control knows the balance. Degrades to a disabled control
   without `loyalty.read`.
3. **Receipt + success panel** — a "Redeemed −₹X (N pts)" line (next to the
   discount line), via `redeemedForOrder`. The M10 "Points earned" line and the
   loyalty block (now showing the reduced balance) are unchanged.

No new component; the redemption control reuses the existing discount-field
idiom, and the receipt reuses the M10 derivation pattern.

## 8. Security & authorization

- **Redemption is gated `loyalty.redeem`** — the cashier's till permission
  (seeded to CASHIER/MANAGER/OWNER, not KITCHEN), checked in `create()` when
  `redeemPoints` is present, exactly as `order.discount` gates a manual discount.
  The automatic *earn*/restore stay unauthenticated system consequences (M10);
  the discretionary *spend* is permissioned.
- **Server-authoritative & overspend-safe.** The client sends points, never an
  amount; the server caps (`redemptionFor`) and computes the discount. The
  customer `FOR UPDATE` lock inside the order tx makes concurrent redemptions for
  one customer serialize — no double-spend past zero, proven by test.
- **Atomicity is the integrity guarantee.** Discount and debit are one tx; the
  `discount ≤ subtotal` / `total = subtotal − discount + tax` CHECKs are the
  last-line defence against a computation bug (the insert fails rather than a
  wrong bill).
- **RLS unchanged** — customer, order, ledger all tenant-scoped; `redeemPoints`
  only ever debits *this* tenant's verified customer.
- **Tier integrity** — `REDEEM_REVERSAL` is deliberately non-status, so
  redeem→refund→restore cycles cannot inflate lifetime-earned/tier.

## 9. Testing strategy

Reuse the Jest + Supertest e2e harness.

- **Redeem at checkout:** `discountMinor = P×100`, `total` correct; balance drops
  by `P`; a `REDEEM` row carries the `order_id`; `loyalty.redeemed` event present.
- **Caps:** redeeming more than the balance, or more than the subtotal-worth, is
  capped (or refused) — never over-discounts, never wastes points, never below
  zero (concurrent-redemption race asserted, like the M2 redeem test).
- **Exclusivity:** `redeemPoints` + `couponCode`/`manualDiscountMinor` → 400.
  Redemption without a customer, or on a held order → 400. Without
  `loyalty.redeem` → 403.
- **Earn interaction:** an earned order earns on the **reduced** net.
- **Refund re-credit:** refunding a redemption order restores `P` points
  (`REDEEM_REVERSAL`), leaves **lifetime-earned/tier unchanged**, and reverses
  the (reduced) earn; a second refund does not double-restore; a refund of a
  no-redemption order is a no-op.
- **Idempotency:** a replayed create (same key) redeems once.
- **Regression + cleanup:** specs that pay a customer order already clear
  `loyalty_ledger` (M10); no new cleanup surface.
- **Gate:** lint, typecheck, build, unit + e2e green; live-server check
  (redeem → discount → refund → restore); manual browser pass of the POS control.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **A schema migration** (`REDEEM_REVERSAL`) on a shared DB | Additive enum value + one partial index; deploy the migration before the code (standard order). Symmetric with the existing `REFUND_REVERSAL`; no data backfill. |
| Redemption debit vs discount desync | Impossible: both are in the **one** order tx; a failure rolls back both. CHECKs are the last-line proof. |
| Over-redeem / waste points | `redemptionFor` caps at `min(balance, floor(subtotal/RATE))`; the lock serializes concurrent redemptions; e2e-proven. |
| "Spend points **and** earn less" surprises the owner | Intended & documented: redemption is a discount, earn is on net — identical to coupons. Surfaced on the receipt (both the −₹ redeemed and the + earned lines). |
| Non-proportional refund restore over-credits a partial refund | Agreed ceiling, symmetric with M10's earn-reversal; `REDEEM_REVERSAL` restores all once. Proportional model is a documented later option. |
| Held/resumed orders | `redeemPoints` refused on a hold; a resumed order redeems at the placement create like any sale. |

## 11. Acceptance criteria

**Functional**
- A cashier with a customer attached can redeem N points for an ₹N discount; the
  bill, the debit, and the record all commit together.
- The discount is server-computed and capped; the client never sets an amount;
  concurrent redemptions never drive the balance below zero.
- Redemption is mutually exclusive with coupon/manual; refused without a
  customer, on a held order, or without `loyalty.redeem`.
- Refunding a redemption order restores the points once, leaving tier unchanged,
  and reverses the reduced earn.
- POS success panel + printed/WhatsApp bill show "Redeemed −₹X (N pts)",
  server-derived; Timeline/Analytics reflect the redemption with no change.

**Integrity / non-functional**
- `total = subtotal − discount + tax`, `discount ≤ subtotal` always hold.
- One schema change only (`REDEEM_REVERSAL`); no new table/endpoint/cache/worker;
  the rate lives once in `loyalty.rules.ts`.
- lint, typecheck, build, unit + e2e green; live + manual verification done;
  `loyalty.md` + roadmap updated.

## 12. Out of scope (YAGNI) & future work

- **Stacking** redemption with coupon/manual (kept exclusive for v1).
- **Proportional** refund restore / earn-reversal (both stay all-or-nothing).
- **Per-tenant redeem rates / min-redemption thresholds / points→tax** (rate is
  one constant; redemption is subtotal-only, like every discount).
- **Redeem on an existing unpaid order** (redemption is set at create, with the
  bill; a pay-later order was already priced).
- **Partial-point auto-suggest / "max out" UI sugar** — the control shows the cap;
  fancier UX later.
- **Coupons/cashback/referrals/birthday/expiry** — separate roadmap items on the
  same ledger.
