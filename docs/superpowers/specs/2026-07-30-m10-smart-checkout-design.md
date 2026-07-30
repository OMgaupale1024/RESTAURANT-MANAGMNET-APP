# M10 — Smart Checkout — Design Document

**Status:** Proposed (awaiting approval)
**Date:** 2026-07-30
**Scope:** approved by product — wire the loyalty foundation (M2) into the money
flow so a paid sale *earns* and a refund *reverses*, automatically. No new
loyalty mechanism; this milestone is the wiring the foundation was built for.

> The M2 foundation named this milestone by name and left the seams open for it:
> *"wiring them into checkout and refunds is the **Smart Checkout** milestone,
> which will call the same `LoyaltyService` methods"* (`docs/architecture/loyalty.md`),
> and the receipt reserves a line — *"Points earned on this order arrives when
> Smart Checkout wires earning into payment; until then it is not shown, not
> faked"* (`apps/web/src/lib/receipt.tsx`). M10 closes both.

---

## 1. Objectives

1. **Earn points automatically the moment an order is fully paid** — from the
   financial settlement itself, so a single full payment *and* the final leg of
   a split both credit correctly, with no cashier action.
2. **Reverse earned points automatically on any refund** of that sale, so a
   customer cannot keep loyalty status for money that was handed back.
3. **Change no loyalty mechanism.** Reuse the idempotent `earnForOrder` /
   `reverseForOrder` seams, the ledger, the rules engine, the events, the
   analytics, and the receipt block **exactly as they already exist.** M10 is a
   *trigger*, not a new subsystem.
4. **Never let loyalty endanger money.** Loyalty runs *after* the payment/refund
   transaction commits; a loyalty failure can never roll back or fail a sale.
5. **Ship safely:** tests, documentation, roadmap update, no regressions, manual
   browser verification before commit.

### Alignment with engineering principles

| Principle | How this design honours it |
|---|---|
| Audit first | Full flow traced (create / recordPayment / recordRefund / LoyaltyService / POS / receipt / analytics) before any design. |
| Reuse before creating | `earnForOrder`, `reverseForOrder`, `pointsForOrder`, `EventsService`, Timeline, Analytics, `getLoyaltySummary`, `BillReceipt`'s `LoyaltyBlock` — all reused as-is. |
| Extend before rewriting | Three post-commit call-sites + one module import. No method rewritten; no signature broken. |
| Single source of truth | "Fully paid" is the captured-sum vs total already computed in `recordPayment`; points are `pointsForOrder` server-side; earned-this-order is read back from the ledger, never recomputed on the client. |
| Server-authoritative | The client never sends a points amount; settlement and points are decided in Postgres from frozen order columns. |
| No duplicated business logic | No second "is paid" check, no second points formula, no second reversal rule. |
| No duplicated data models / APIs | **No new table, no new endpoint, no new event, no new ledger primitive.** |
| No new caches / workers | Post-commit, in-request, awaited; no queue, no outbox, no background job. |

---

## 2. Architecture overview

M2 already split loyalty into **policy** (`loyalty.rules.ts`, pure), **mechanism**
(`LoyaltyService`, append-only ledger, idempotent), and **surface** (summary API,
receipt block, profile section). All three are done. What was missing is a single
thing: **nobody calls the earn/reverse seams from the money flow.** M10 adds that
call and nothing else.

The design is one sentence: **after a financial transaction commits, if it left
the order fully paid, credit its points; if it handed money back, reverse them —
and swallow any loyalty error so the sale stands regardless.**

```
        FINANCIAL TX (authoritative, unchanged)          POST-COMMIT (loyalty, best-effort)
        ─────────────────────────────────────            ──────────────────────────────────
create({paymentMethod})  ─ full capture ──┐
recordPayment(final leg) ─ balance → 0 ───┼─ commit ──►  creditLoyalty(orderId)  → earnForOrder()   [idempotent]
recordRefund()           ─ money out ─────┴─ commit ──►  reverseLoyalty(orderId) → reverseForOrder() [idempotent]
```

Two properties make this safe with no new infrastructure:

- **The financial write is already committed** before loyalty is touched, in a
  *separate* transaction. A loyalty exception is caught and logged; the request
  still returns the settled order. Money never depends on points.
- **The seams are already idempotent** (`EARN`/`REFUND_REVERSAL` are unique per
  `(order, type)`). A retried request, a double-fired trigger, or a manual
  recovery call all converge on exactly one credit and one reversal.

This is deliberately **at-most-once with manual recovery**, not exactly-once. The
one gap — process death in the millisecond between commit and the earn call —
is closed by the *existing* `POST /orders/:id/loyalty/earn` endpoint, which is
idempotent. Choosing a transactional outbox to make it exactly-once is a real
option we are **not** taking in M10 (§10, §12): it is the "no background jobs,
no queues" line the milestone drew.

---

## 3. Existing systems to reuse (untouched)

- **`LoyaltyService.earnForOrder(orderId)`** — reads the order, refuses an
  anonymous / voided / cancelled sale, computes points via `pointsForOrder`,
  appends one `EARN` idempotently, emits `loyalty.earned`. **The earn seam.**
- **`LoyaltyService.reverseForOrder(orderId)`** — appends one `REFUND_REVERSAL`
  of the full earned amount, idempotently; the one entry allowed to go negative;
  emits `loyalty.refund_reversed`; throws `NotFound` when nothing was earned.
  **The reverse seam.**
- **`loyalty.rules.pointsForOrder`** — net-spend formula (`subtotal − discount`,
  tax excluded). The single points authority; never reimplemented client-side.
- **`EventsService` (M0)** — `earnForOrder`/`reverseForOrder` already record
  `loyalty.earned` / `loyalty.refund_reversed` inside their own transaction. So
  **Timeline (M5) and Customer History see checkout loyalty for free** — no new
  event, no new emit in the orders flow.
- **Analytics (M6) `loyaltyStats`** — reads `loyalty_ledger` directly
  (`SUM(EARN)`, `SUM(REDEEM)`, distinct members). Auto-earn/reverse flow into
  the insights "loyalty" block with **zero analytics change.**
- **`getLoyaltySummary` + `GET /customers/:id/loyalty`** — already returns
  balance, tier, next-tier, and `recentEntries` (each carrying `orderId`,
  `type`, `points`). The POS reads it; the earned-this-order figure is *looked
  up* here, not recomputed.
- **`BillReceipt` / `LoyaltyBlock` (M3)** — already render tier, balance,
  lifetime, next-tier as text; already omit gracefully for a guest or a
  no-`loyalty.read` caller. M10 passes it the summary POS already can fetch.
- **The post-commit idiom** — `OrdersService` already lifts a boolean out of a
  transaction and acts on it after commit (`let changed` → realtime emit in
  `updateStatus`). The earn trigger is the same idiom, reused.

---

## 4. Components/services to extend

The entire backend change is in **`OrdersService`** (+ its module import). No new
file.

### 4.1 `OrdersModule` — import `LoyaltyModule`

`LoyaltyModule` already `exports: [LoyaltyService]`; it imports only
`EventsModule`, so there is **no dependency cycle** (`OrdersModule` →
`LoyaltyModule` → `EventsModule`). Add `LoyaltyModule` to `OrdersModule.imports`
and inject `LoyaltyService` into `OrdersService`.

### 4.2 Two private post-commit helpers on `OrdersService`

```ts
/** Post-commit earn. The financial tx has ALREADY committed; a loyalty failure
 *  is swallowed (manual recovery is POST /orders/:id/loyalty/earn). Idempotent
 *  at the ledger, so a retry or double-fire never double-credits. */
private async creditLoyalty(orderId: string): Promise<void> {
  try { await this.loyalty.earnForOrder(orderId); }
  catch (e) { this.logger.warn(`loyalty earn failed for order ${orderId}`, e); }
}

/** Post-commit reverse. A refund on a sale that never earned (anonymous, or
 *  never fully paid) is a benign no-op — reverseForOrder throws NotFound, which
 *  we treat as "nothing to reverse". Anything else is logged for manual
 *  recovery (POST /orders/:id/loyalty/reverse). */
private async reverseLoyalty(orderId: string): Promise<void> {
  try { await this.loyalty.reverseForOrder(orderId); }
  catch (e) {
    if (e instanceof NotFoundException) return;
    this.logger.warn(`loyalty reversal failed for order ${orderId}`, e);
  }
}
```

Both are called **outside** the `prisma.tx(...)` block, after it resolves, still
inside the HTTP request (so `prisma.requireContext()` — tenant + RLS — is live;
the automatic earn carries a `null` actor, correctly: no human granted it).

### 4.3 Three trigger sites (the only behavioural change)

| Site | Condition (lifted from the committed tx) | Call |
|---|---|---|
| `create()` | `dto.customerId && dto.paymentMethod` — a payment at placement is always the **full total** (`insert()` writes `amountMinor: total`), so this *is* "fully paid with a customer". | `await this.creditLoyalty(order.id)` |
| `recordPayment()` | `becameFullyPaid` = `order.customerId != null && outstanding − dto.amountMinor === 0`, where `outstanding` is **already computed** in the method. Lift it out like `changed`. | `await this.creditLoyalty(orderId)` |
| `recordRefund()` | always (a refund only reaches here against a captured sale). | `await this.reverseLoyalty(orderId)` |

`recordPayment` today selects `{ id, status, totalMinor }`; add `customerId` to
that `select` so the trigger can gate on it without a second read. That is the
only query touched.

Deliberately **not** a trigger site: `updateStatus(... COMPLETED)`. Completion is
fulfilment, not settlement — an order can be COMPLETED yet unpaid (pay-later).
Earning follows *money*, per the agreed decision, so it hooks payment, never
status. (A pay-later order earns when its balance hits zero via `recordPayment`,
whatever its kitchen status.)

---

## 5. API changes

**None to the request/response contract.** No new endpoint, no new field, no
changed DTO. `create`, `recordPayment`, and `recordRefund` return the same
`Order` shape; the loyalty write is a post-commit side effect the response does
not carry (the POS reads points via the *existing* `GET /customers/:id/loyalty`).

The manual `POST /orders/:id/loyalty/earn` and `/reverse` endpoints (M2) are
**unchanged** and become the documented recovery path rather than the primary
one.

> Why not return points on the order response? It would couple the orders API to
> loyalty and put a `loyalty.read` concern on every order reader. The POS already
> fetches the summary separately and degrades to "no loyalty" without it — the
> M9/receipt idiom. Keeping them separate is the lazier *and* the safer choice.

---

## 6. Data flow

### Earn — full payment at placement (`charge()`, non-split)

```
POS charge()  ──► createOrder({ items, paymentMethod, customerId, … })
                     │  [order.create]
                     ▼
   OrdersService.create → insert(): order + CAPTURED payment (= total)   ┐ one tx
                                     + stock + order_event                ┘ commits
                     │
                     ├─ (post-commit) realtime 'order.created'
                     └─ (post-commit) creditLoyalty(order.id)
                                          └─ earnForOrder → +EARN, loyalty.earned event   [idempotent]
```

### Earn — split / pay-later (`recordLeg()` → the final leg)

```
POS recordLeg()  ──► recordPayment(orderId, { method, amountMinor, idempotencyKey })
                        │  [order.update]
                        ▼
   OrdersService.recordPayment: cap at outstanding; insert leg; order_event   ┐ one tx
                        │  becameFullyPaid = customerId && outstanding-amt==0  ┘ commits
                        └─ (post-commit, only when becameFullyPaid)
                              creditLoyalty(orderId) → earnForOrder → +EARN     [idempotent]
```

Intermediate legs (balance still owed) do **not** earn; only the settling leg
does. Two legs cannot both "settle" — the first to zero the balance earns, the
seam's uniqueness makes a re-fire a no-op.

### Reverse — refund

```
POS/Orders refund  ──► recordRefund(orderId, { method, amountMinor, reason })
                          │  [order.refund]
                          ▼
   OrdersService.recordRefund: cap at refundable; insert refund; order_event;   ┐ one tx
                          │  order.refunded audit event                          ┘ commits
                          └─ (post-commit) reverseLoyalty(orderId)
                                 └─ reverseForOrder → −(full EARN), loyalty.refund_reversed   [idempotent]
                                    (NotFound when nothing was earned → silent no-op)
```

Everything the client sees afterwards (receipt, profile, timeline, analytics)
reads the *ledger*, never a number the client computed.

---

## 7. UI/UX changes — `apps/web` POS (`pos-client.tsx`, `receipt.tsx`)

The backend is the milestone; the UI is a thin, reuse-only confirmation so the
counter *sees* the reward land. All of it degrades to silence without
`loyalty.read` or without a customer — the documented loyalty idiom.

1. **Fetch the summary once the order is settled with a customer.** On the
   success panel, when captured ≥ total and `success.customer` exists, call the
   existing `getLoyaltySummary(customer.id)` (best-effort; 403/error → omit).
   This is the same trigger the panel already uses to decide it's fully paid.
2. **Earned-points confirmation** on the success panel: one line, e.g.
   **`★ Silver · 1,240 points (+45)`**. The `+45` (earned on *this* order) is
   `recentEntries.find(e => e.orderId === success.id && e.type === 'EARN')?.points`
   — **server-derived, no client formula**, omitted if not found (old-order
   reprint). Reuses the receipt's `pts()` Indian-grouping formatter.
3. **Pass the summary into the bill.** POS builds `<BillReceipt order profile />`
   today (no loyalty); pass the fetched summary:
   `<BillReceipt order profile loyalty={summary} />`. `LoyaltyBlock` already
   renders tier/balance/lifetime/next-tier for print and WhatsApp.
4. **Light up the reserved receipt line.** Extend `LoyaltyBlock` with the
   "Points earned on this order: +N" line it left a comment for, fed the same
   server-derived `+N` (a prop; omitted when absent — never faked, per its own
   contract).

No new component, no new client dependency, no client-side points math. The
customer **list**, order detail, and every other surface are untouched (they
already read loyalty where relevant via M9).

---

## 8. Security & authorization

- **Auto-earn is a *consequence* of an authorized settlement, not a discretionary
  grant — so it correctly runs under `order.create` / `order.update` without
  `loyalty.adjust`.** This is the same shape as stock depletion: placing a sale
  depletes inventory as a *consequence*, without the cashier holding an
  inventory-management grant. The cashier cannot choose the points, cannot pick
  the customer, cannot credit without a real fully-paid sale — points are a pure
  function (`pointsForOrder`) of an order they were already permitted to settle.
  The `loyalty.adjust` gate stays exactly where the threat model wants it: on the
  **manual** award/correct/reverse endpoints, the discretionary money-adjacent
  actions a manager performs by hand.
- **Auto-reverse runs only under `order.refund`** (Manager/Owner). Cashiers hold
  neither `order.refund` nor `loyalty.adjust`, so they can neither refund nor
  claw back points — unchanged from today.
- **Internal calls are not re-authorized, and must not be.** `earnForOrder` is
  invoked service-to-service, not via its HTTP route, so `PermissionsGuard` does
  not (and should not) re-check `loyalty.adjust` — the guarding decision was
  already made at the order route. This is intended, and called out so a future
  reviewer does not "fix" it into a bug.
- **Points and settlement are server-authoritative.** The client sends a code /
  a paid amount, never a points figure; `pointsForOrder` reads frozen order
  columns (`subtotalMinor`, `discountMinor`). The earned-this-order number the
  UI shows is read *back* from the ledger, so a tampered client can misdisplay
  its own screen but cannot change what was credited.
- **Tenant isolation unchanged.** `earnForOrder`/`reverseForOrder` run in
  RLS-scoped transactions in the same request context; no `restaurantId` is
  passed or trusted. A cross-tenant order id simply is not found.
- **No new PII, no new surface.** No new endpoint, no new event, no new column;
  the loyalty events already carry ids and amounts only, no name/phone.
- **Display is gated, earning is not.** A cashier without `loyalty.read` still
  *earns* the customer their points (system consequence) but simply doesn't see
  the confirmation/receipt block — no leak, no error, no partial render.

---

## 9. Testing strategy

Reuse the existing Jest + Supertest e2e harness (`payments`, `loyalty`, `pos`,
`analytics` specs); no new framework.

**Earn**
- Full payment at placement (`create` with `paymentMethod` + `customerId`)
  credits `pointsForOrder(order)` exactly once; balance and tier reflect it.
- Split: intermediate legs credit **nothing**; the leg that zeroes the balance
  credits once. Re-posting the settling leg (same idempotency key) does not
  double-credit.
- Anonymous order (no `customerId`) credits nothing and raises no error.
- Voided / cancelled order credits nothing.
- Points equal `floor((subtotal − discount) / 1000)` — tax excluded — asserted
  against the rules engine, not a hand-copied number.

**Reverse**
- A refund on an earned sale reverses the **full** earned amount once; lifetime
  and tier walk back; balance may go negative (allowed).
- Any refund amount (partial or full) reverses all — the agreed M10 rule.
- A second refund on the same order does not double-reverse (idempotent).
- A refund on a sale that never earned is a silent no-op.

**Isolation of failure (the core guarantee)**
- With loyalty forced to throw, `recordPayment` / `recordRefund` still commit and
  return the settled order; the payment/refund row exists; no 500 to the caller.
- The manual `POST /orders/:id/loyalty/earn` re-credits the missed order
  idempotently (recovery path).

**Regression**
- Audit and update any existing `loyalty`/`pos` e2e that assumed the M2
  "earning does not run automatically on payment" behaviour — that assumption is
  what M10 intentionally flips.
- Analytics loyalty block and Timeline show the checkout-originated
  earn/reverse with no analytics/timeline code change.

**Gate:** lint, typecheck, build, unit + e2e green; manual browser verification —
attach a customer, take a full payment, see `+N` on the panel and on the printed
bill; run a split and confirm only the final leg earns; refund and confirm the
reversal.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Process dies between commit and the post-commit earn** → sale recorded, points not credited (at-most-once). | Rare (millisecond window, same host). Recovery is the *existing* idempotent `POST /orders/:id/loyalty/earn`. Exactly-once via a transactional outbox is the documented upgrade — deliberately **out of scope** (the milestone's "no queues/workers" line). |
| Loyalty error surfacing as a failed sale. | Impossible by construction: loyalty runs in a *separate* transaction *after* commit, wrapped in a swallow-and-log. The financial write cannot be rolled back by it. Proven by the forced-throw e2e. |
| Full (non-proportional) reversal over-punishes a partial refund. | Agreed M10 simplification, documented on the receipt/profile as "points reversed". `REFUND_REVERSAL` type + `reverseForOrder` already exist for a proportional model later; no ledger change needed to upgrade. **ponytail: full reversal; proportional when a tenant asks.** |
| Double-fire from a retried request or two triggers. | Ledger uniqueness `(order, type)` makes earn/reverse idempotent; the unique race is caught outside the tx and answered with a read (M2's existing pattern). |
| Completion vs settlement confusion (earning on the wrong event). | Trigger is bound to payment only, never to `COMPLETED`; asserted by a pay-later test (COMPLETED-but-unpaid earns nothing until paid). |
| Extra best-effort summary fetch on the success panel. | Not a hot path; one indexed read; degrades to silence on 403/error. Points still earn server-side regardless of the fetch. |
| Re-earn after refund-then-repay. | Out of scope: once reversed, a later full payment finds the existing `EARN` and does not re-credit. Documented; acceptable for M10. |

---

## 11. Acceptance criteria

**Functional**
- Paying an order in full **with a customer attached** credits that order's
  points automatically — for both a single full payment and the settling leg of
  a split — with no cashier action.
- Refunding such an order reverses **all** its earned points automatically.
- The POS success panel shows the customer's tier, new balance, and the points
  earned on this order (`+N`); the printed and WhatsApp bill show the loyalty
  block including the earned-on-this-order line.
- An anonymous sale, a voided/cancelled order, and a still-owed split leg earn
  nothing and raise no error.
- The Customer Profile loyalty section (M9), Timeline (M5), and Analytics loyalty
  block (M6) reflect checkout-originated earn/reverse — with no change to those
  modules.

**Integrity / non-functional**
- A loyalty failure never fails, delays fatally, or rolls back a payment or
  refund (forced-throw test green); the sale is always authoritative.
- Points are `pointsForOrder` server-side; the client never supplies a points
  amount; earned-this-order is read back from the ledger.
- Earn/reverse are idempotent — retries, double-fires, and manual recovery
  converge on one credit / one reversal.
- **No new table, endpoint, event, ledger primitive, cache, or background job.**
- RLS/authorization unchanged; auto-earn runs as a settlement consequence under
  `order.create`/`order.update`; auto-reverse only under `order.refund`.
- lint, typecheck, build, unit + e2e green; manual browser verification done;
  `docs/architecture/loyalty.md` "what this milestone does not do" and
  `docs/ROADMAP.md` updated to mark M10 complete.

---

## 12. Out of scope (YAGNI) & future work

- **Transactional outbox / exactly-once delivery.** The at-most-once + manual
  recovery model is the agreed delivery strategy; an outbox is the named upgrade
  when a tenant's scale or audit needs demand it. Not now.
- **Proportional refund reversal.** M10 reverses the full earned amount on any
  refund. The type and seam already support a proportional model; add it when
  asked, no schema change required.
- **Points → discount redemption at checkout.** Spending points to reduce a bill
  is a distinct flow (`redeem` exists; the POS redemption UI does not). Separate
  milestone.
- **Re-earn after refund-then-repay**, **points expiry**, **per-tenant earn
  rates / tier ladders**, **bonus multipliers / campaigns** — all remain
  behind the `loyalty.rules.ts` seam, none built here.
- **No** change to the orders API contract, **no** client-side points math,
  **no** new loyalty surface beyond lighting up the receipt line M3 reserved.
