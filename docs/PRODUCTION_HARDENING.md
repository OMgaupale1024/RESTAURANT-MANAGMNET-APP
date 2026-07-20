# Production Hardening

Canonical status for the OraOS production-hardening effort. If the chat history
is lost, resume from the latest pushed commit and this file.

- **Branch:** `production-hardening`
- **Base:** `main`
- **Current production status:** hardening in progress; no known unshipped defects on completed sprints.

## Completed sprints (approved)

| Sprint | Fix | Commit |
|---|---|---|
| C1 | Multi-restaurant picker — read the `rid` claim so multi-restaurant users can sign in | `2cb00bd` |
| H1 | Inventory reversal — return stock to the ledger when an order is voided/cancelled | `fd96d48` |
| M1 | Analytics timezone — anchor the "today" window to the tenant TZ, not the host | `bade365` |
| H4 | Logout Everywhere — logout-all revokes every session; session epoch closes the race; invalidation across select-restaurant/staff/sockets | `4038500`, `9c2281c`, `ce8a326` |
| C3 | Refresh race | (auth cluster above) |
| C4/C5 | Authentication completion | (auth cluster above) |
| H5 | Order idempotency — order creation idempotent on the order, not the payment | `84584a4` |
| 2C | Inventory adjustment idempotency — exactly-once manual stock movements (this sprint) | see latest commit |

## Closed investigations (no code changes)

- **M2 — Timesheet day-boundary.** Investigated + browser-verified; not reproducible. Closed no-code. (2026-07-20)
- **H3 — RBAC runtime hardening.** Runtime permission matrix passed; all mutation routes protected; existing e2e coverage confirmed. Closed no-code. (2026-07-20)

## Sprint 2C — Inventory adjustment idempotency

**Discovered during:** H5 (order idempotency).

**Issue.** Manual inventory mutations (receipt/`PURCHASE`, `WASTE`, and stock-count
`ADJUSTMENT`) were not idempotent. A retry, refresh, double-click, or concurrent
identical request applied the same stock movement twice, corrupting the ledger.

**Fix.** Reused the H5 pattern. Added a nullable `idempotency_key` to
`stock_movements` with a unique index `(restaurant_id, idempotency_key)`; NULLs do
not collide, so server-written `CONSUMPTION` and reversal rows are unaffected. The
two manual-movement service paths now route through `writeOnce(key, write)`: it
returns the existing row for a replay and converts a lost concurrent race
(unique violation) into the original row. The web client sends a per-intent UUID
key, regenerated on input change and after a successful record.

**Files changed.**
- `apps/api/prisma/schema.prisma` — `idempotencyKey` + compound unique on `StockMovement`
- `apps/api/prisma/migrations/20260720205830_stock_movement_idempotency/` — column + unique index
- `apps/api/src/modules/inventory/dto/inventory.dto.ts` — `idempotencyKey` on both DTOs
- `apps/api/src/modules/inventory/inventory.service.ts` — `writeOnce` / `findMovementByKey`
- `apps/api/test/inventory.e2e-spec.ts` — 6 idempotency e2e cases
- `apps/web/src/lib/api.ts`, `apps/web/src/app/dashboard/inventory/inventory-client.tsx` — client sends the key

**Verification.** typecheck ✓ lint ✓ build ✓ · inventory e2e 29/29 ✓ (incl. duplicate
receipt, duplicate adjustment, browser retry, network retry, 5-way concurrent,
distinct keys, no-key). Live-server HTTP probe and full browser UI record →
replay confirmed exactly-once end-to-end.

## Remaining backlog

None scheduled. See `docs/BACKLOG.md` for the general backlog. Next sprint: TBD.
