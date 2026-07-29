# Inventory Intelligence

The owner's read on stock: what it's worth, what needs attention, and what
moved. Read this before adding an inventory metric or a movement type — the
first rule is *derive from the ledger, never cache a counter.*

## What it is

Inventory is one append-only ledger — `stock_movements` — and everything else is
**derived** from it. There is deliberately **no `quantity` column** on
`Ingredient`: current stock is `SUM(quantity)` over the ledger, a customer's
balance-style pattern shared with the loyalty and cash ledgers. A mutable
counter would be a lie the moment two orders touched it; a ledger answers both
"how much" and "where did it go", and makes concurrent depletion correct for
free.

Movement types (signed): **PURCHASE** (+, stock in, with supplier + total cost),
**CONSUMPTION** (−, written by the server when an order is placed, via the
recipe), **WASTE** (−, spoilage), **ADJUSTMENT** (± a stock count / reversal).

The **intelligence layer** this milestone added is a single aggregate,
`GET /inventory/summary` (`inventory.read`), computed in Postgres from that same
ledger. The stock list (`GET /ingredients`) already returned per-ingredient
`currentStock` / `isLow` / `avgDailyUsage` / `avgUnitCostMinor` /
`lastMovementAt`; the summary adds the roll-up the list could not: total value,
a health partition, today's flow, and wastage. The web page renders it as a
dashboard header plus a client-derived "Needs attention" list.

## What already existed, and was reused (not rebuilt)

The audit found ~90% present. Reused verbatim:

- **`stockByIngredient`** — `SUM(quantity)` per ingredient, one `groupBy`.
- **`costByIngredient`** — weighted-average unit cost from priced PURCHASEs
  (`SUM(total_cost) / SUM(quantity)`), the standard method. The summary's stock
  value and 30-day waste value both reuse it, so no cost logic is duplicated.
- The **7-day CONSUMPTION** average the list already computes for "daily usage".
- Ingredient / supplier CRUD, recipe get/set, order depletion & restock, and the
  detail ledger — **untouched**.

Nothing new was stored. The summary is a read; it introduces no table, no
column, no cached total, no job.

## The dashboard it answers

| Owner question | Where it comes from |
| --- | --- |
| What is stock worth? | `valueMinor` = Σ(currentStock × weighted-avg cost) |
| What will run out today? | **critical** tier — positive stock ≤ one day of recent usage |
| What should be reordered? | **low** tier — at/below reorder level (+ the reorder suggestions in Procurement) |
| What's out / negative? | **out** (=0), **negative** (<0) tiers |
| What is today's stock movement? | `today` — received/depletions/waste counts + ₹ spent |
| What is waste costing me? | `wasteMonthMinor` — 30-day WASTE × cost |
| Which items need attention now? | client-derived list of the off-healthy rows, most urgent first |

**Health is a partition** — each active ingredient in exactly one bucket, by
priority `negative < out < critical < low < healthy`. "Critical" needs no
reorder level (an untracked ingredient can still be running out); "low" is the
reorder-level flag. Nothing is fabricated: an ingredient with no cost basis
contributes nothing to value (not a fake zero), and "days left" shows only when
there is real recent usage to divide by.

## Alerts

The "Needs attention" panel is exactly that — the off-healthy rows surfaced at
the top of the page, sorted most-urgent-first, each a one-tap link to record a
receipt. It is **not** a notification framework: no channel, no delivery, no
subscription — just the operational list an owner scans each morning. Negative
stock is shown honestly (the sale was allowed to happen; the discrepancy is the
owner's to resolve), never hidden.

## Consumption

Consumption is **real, not estimated**: `RecipeItem` maps each product to the
ingredients one unit consumes, and `InventoryService.depleteForOrder` writes the
CONSUMPTION rows inside the order transaction, so stock and the sale commit
together. Where a product has no recipe it depletes nothing (a bottled drink
sold as-is) — a legitimate state, never a fabricated deduction. The 7-day
consumption average drives both "daily usage" and the critical tier.

## Performance

- **One transaction, serial aggregates** (the `@prisma/adapter-pg` rule: one
  interactive tx is one connection, no concurrent queries on it).
- Every scan rides the existing `(restaurant_id, ingredient_id, created_at)`
  index; the health partition is computed in memory from three `groupBy`s, not
  one query per ingredient. No N+1, no polling, no duplicate query — the page
  loads the list and the summary once each.
- The attention list is derived on the client from rows already loaded — zero
  extra requests.

## Security

- `inventory.read` to see, `inventory.manage` to record — both unchanged; the
  summary shares the read gate. `inventory.read` reaches owner/manager/kitchen
  (a kitchen seeing stock health is correct).
- **RLS is the boundary** — every query runs inside `prisma.tx` scoped to
  `app.restaurant_id`; the summary can only ever aggregate the caller's tenant.
- CONSUMPTION is server-only (a client posting it could make stock vanish
  without a sale); the manual endpoints derive a movement's sign from its type,
  never from the client.

## Future extensibility

Found during review, **not** built:

- **Per-tenant critical/lead-time thresholds** — "critical" is a fixed one-day
  heuristic; a settings row could make the horizon and a lead-time buffer
  configurable.
- **Value trend over time** — a stock-value series would need either a periodic
  snapshot or a point-in-time `SUM` per day; deferred until an owner asks (live
  value is enough today).
- **FIFO/lot costing** — the weighted average is what a counter kitchen reasons
  about; FIFO COGS needs lot tracking, its own project.
- Procurement (purchase orders, reorder suggestions, supplier insights) is the
  sibling milestone — see [`procurement.md`](./procurement.md).
