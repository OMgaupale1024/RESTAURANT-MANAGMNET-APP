# Production Hardening

Canonical status for the OraOS production-hardening effort. If the chat history
is lost, resume from the latest pushed commit and this file.

- **Branch:** `production-hardening`
- **Base:** `main`
- **Current phase:** v1.0 Release Preparation (see bottom). Production hardening is **frozen** — do not revisit unless a direct regression is found.
- **Current production status:** hardening complete; no known unshipped defects.

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
| 2C / H6 | Inventory adjustment idempotency — exactly-once manual stock movements | `ec745b0` |

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

---

# v1.0 Release Preparation

Production hardening is complete and frozen. This phase prepares OraOS for real
deployment, one small independent milestone at a time (implement → test →
browser-verify → commit → push before the next).

## Milestones

| # | Milestone | Status |
|---|---|---|
| 1 | Invite acceptance security — refresh token via httpOnly cookie, not JSON | ✅ done |
| 2 | Password reset (forgot / token / expiry / email / browser flow) | ⬜ next |
| 3 | Email infrastructure (Resend) | ⬜ |
| 4 | Production monitoring (`/health`, readiness, structured logging, request IDs, error reporting, graceful shutdown) | ⬜ |
| 5 | Docker (API, Web, prod compose, env handling) | ⬜ |
| 6 | GitHub Actions CI (install, lint, typecheck, test, build) | ⬜ |
| 7 | Production deployment (env, reverse proxy, HTTPS, guide, backups, migration & rollback, zero-downtime) | ⬜ |

## Milestone 1 — Invite acceptance security

**Issue.** `POST /join/:token` (invite acceptance) returned the full
`IssuedTokens` — including the **refresh token — in the JSON body**, and never
set the refresh cookie. Login/register put the refresh token in an httpOnly
cookie and return only the access token; the invite path skipped that, so a
stolen-by-XSS refresh token was a persistent session, and an accepted invite's
session would not even survive a page reload (no cookie to refresh from).

**Fix.** Extracted the refresh-cookie contract (`oraos_rt`, httpOnly, `sameSite:
strict`, path `/api/v1/auth`) out of `AuthController` into one shared helper,
and routed both `AuthController` and `JoinController` through it. The invite
path now sets the httpOnly cookie and returns only `{ accessToken, expiresIn,
tokenType }`. Single source of truth for the cookie, so the paths cannot drift.
No web change — the client already used `credentials: 'include'` and ignored any
`refreshToken` field.

**Files changed.**
- `apps/api/src/modules/auth/refresh-cookie.ts` — new shared helper
- `apps/api/src/modules/auth/auth.controller.ts` — use the helper (behaviour-identical)
- `apps/api/src/modules/staff/staff.controller.ts` — `JoinController` sets the cookie
- `apps/api/test/staff.e2e-spec.ts` — asserts cookie set, no `refreshToken` in body, cookie refreshes

**Verification.** typecheck ✓ lint ✓ build ✓ · auth + staff e2e 63/63 ✓. Browser:
invite accepted → no `refreshToken` in body, `oraos_rt` httpOnly cookie at
`/api/v1/auth`, session survived a full reload.

## General backlog

See `docs/BACKLOG.md`.
