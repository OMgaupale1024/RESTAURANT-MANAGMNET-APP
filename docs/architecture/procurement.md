# Procurement & Supplier Management

Restaurant-focused purchasing — suppliers, purchase orders, and reorder
intelligence. Read this before touching a purchase order or a supplier metric.
The first rule is *a received order writes ordinary stock movements; there is no
second purchase history.*

## What it is

Procurement is a thin planning layer over the inventory ledger, not an ERP:

- **Suppliers** already existed (tenant-scoped, deactivate-not-delete, a
  `preferred` flag added here as a reorder hint). Their **insights** —
  `GET /suppliers/insights` — are rolled up from the PURCHASE `stock_movements`
  that receiving already writes: total spend, purchase count, last purchase,
  average days between purchases, and the ingredient bought most.
- **Purchase orders** — `purchase_orders` + `purchase_order_items` — are the one
  new model: a planned buy with a lifecycle **DRAFT → ORDERED → RECEIVED**, or
  **CANCELLED** from DRAFT/ORDERED. **Receiving is the only step that touches
  stock**: it writes a PURCHASE movement per line (quantity, supplier, cost),
  inside the same transaction as the status change, and records nothing about
  the arriving stock anywhere else.
- **Reorder suggestions** — `GET /inventory/reorder-suggestions` — the
  ingredients inventory already flags low, each with a transparent top-up
  quantity and the supplier last bought from.

The web `/dashboard/procurement` page renders all three; `po.*` events flow
through `EventsService` onto the Timeline.

## Reuse decisions (what was NOT rebuilt)

The audit found suppliers and purchase recording already present. So:

- **Purchase history is the stock ledger.** A PO does not store received
  quantities or costs as its own history — receiving writes PURCHASE
  `stock_movements`, the single source the ingredient cost, value and supplier
  insights all already read. The PO keeps only the *plan* and its status.
- **Reorder suggestions reuse `InventoryService.list({ lowStock: true })`** for
  stock, reorder level and 7-day usage — not one line of that computation is
  duplicated. Procurement only adds the last-supplier lookup and the top-up sum.
- **Supplier insights reuse the PURCHASE movements** via `groupBy` — no new
  aggregate table, no snapshot.
- **EventsService** records `po.created` / `po.ordered` / `po.received` /
  `po.cancelled`, so the Timeline shows procurement with no bespoke feed; the
  Timeline's category/labels were extended, not duplicated.
- **Permissions** are the existing `inventory.read` (see) / `inventory.manage`
  (draft, move, receive) — no new permission, since receiving *is* an inventory
  write.

## Data flow

```
Draft PO ──Mark ordered──▶ ORDERED ──Receive──▶ RECEIVED
  (items)                                         │
   └──────────── Cancel ──────────▶ CANCELLED     └─▶ writes PURCHASE stock_movements
                                                       (one per line: qty, supplier, cost)
```

A received or cancelled order is terminal. Receiving is guarded by a
`SELECT … FOR UPDATE` row lock on the PO, so a double-clicked "Receive" cannot
write the movements twice — the second transaction waits, then sees RECEIVED and
is refused. The transition whitelist is server-enforced; a client can only name
a target status.

## Reorder heuristic

Confidence-gated: suggestions are made **only** for ingredients the inventory
already flags low (at or below their reorder level — which requires a reorder
level to be set at all). The suggested quantity tops stock up to the larger of
twice the reorder level or about two weeks of recent daily usage. It is a plain,
inspectable arithmetic — never an opaque "procurement AI" number. Where an
ingredient has never been bought from a recorded supplier, the one-click draft
is disabled (there is no supplier to attribute it to) rather than guessing.

## Performance

- Supplier insights: three `groupBy`s and two small `findMany`s in one
  transaction (serial, per the `@prisma/adapter-pg` rule) — no per-supplier query.
- Reorder suggestions: the reused low-stock list plus one `findMany` for last
  suppliers — no N+1.
- Every scan rides an existing index: `stock_movements(restaurant_id,
  ingredient_id, created_at)`, `purchase_orders(restaurant_id, status)` and
  `(restaurant_id, supplier_id)`. No polling anywhere.

## Security

- `inventory.read` / `inventory.manage`, unchanged; a cashier sees neither.
- **RLS** on `purchase_orders` and `purchase_order_items` — the same
  `tenant_isolation` policy every table carries; every read and write runs inside
  `prisma.tx` scoped to `app.restaurant_id`, so a PO can only ever reference this
  tenant's suppliers and ingredients (existence is confirmed under RLS on
  create). Cross-tenant supplier or ingredient ids are simply "unknown".
- The PO tables are **mutable** (status and draft items change), so unlike the
  money ledgers they carry no append-only trigger. The immutable audit trail of
  what actually happened lives where it should — the PURCHASE `stock_movements` a
  receipt writes, and the `po.*` events on the Timeline.

## Future extensibility

Found during review, **not** built:

- **Partial receipt** — receiving is all-or-nothing today. A partial receipt
  needs a received-quantity per line (a schema the current items table does not
  carry cleanly), so it is deferred rather than bolted on badly.
- **Supplier ↔ ingredient catalogue & agreed prices** — "products supplied" is
  currently inferred from what has been bought; an explicit catalogue with price
  lists would sharpen reorder costing. Its own model, its own milestone.
- **Editing a draft's lines after creation** — today a draft is created whole;
  line editing (add/remove before ordering) is a small follow-up on the same
  model.
- **Supplier reliability (on-time %)** — genuinely measurable only once expected
  vs. actual delivery dates are captured; omitted rather than faked.
