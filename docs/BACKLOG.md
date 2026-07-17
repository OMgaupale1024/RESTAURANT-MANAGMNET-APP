# Backlog

Known gaps, deliberately deferred to the step that owns them. Raised during a
step's security review, scheduled here rather than fixed on the spot.

Nothing here is forgotten work — it is scheduled work. If an item's step
arrives and it is still open, it blocks that step.

| # | Gap | Raised | Target | Why not now |
|---|-----|--------|--------|-------------|
| 1 | **Password reset** — a locked-out owner has no recovery path | Step 5 | Step 20 (needs email provider) | Requires an email service; no provider chosen yet. **Becomes urgent the moment a real restaurant uses this.** |
| 2 | **Email verification** — anyone can register with an address they do not own | Step 5 | Step 20 (needs email provider) | Same dependency. Lower urgency than #1: a fake email hurts the registrant, not the business. |
| ~~3~~ | ~~**Auth events not written to `audit_logs`**~~ | Step 5 | **CLOSED in Step 8** | Separate `security_events` table (global, append-only). Chose this over a nullable `restaurant_id`, which would have punched a hole in the RLS policy. Verified: LOGIN_FAILED recorded for unknown emails; table is tamper-proof. |
| ~~4~~ | ~~**Restaurant selection when a user has >1 membership**~~ | Step 5 | **CLOSED in Step 8** | `POST /auth/select-restaurant`. Membership verified server-side; returns 403 (not 404) for both non-member and non-existent, so existence does not leak. |
| 5 | **`sslmode=require` treated as `verify-full` by pg** — behaviour changes in pg v9 | Step 4 | Step 20 | Currently *stricter* than requested, so not a live risk. Make `sslmode=verify-full` explicit before production. |
| ~~6~~ | ~~**`oraos_api` holds UPDATE/DELETE on `orders`**~~ | Step 4 | **CLOSED in Step 10** | DELETE revoked on orders/order_items/payments. UPDATE kept (Orders/Kitchen need status transitions) but a trigger freezes money columns once status leaves DRAFT. Verified: delete rejected, total edit rejected, status change allowed. |
| ~~7~~ | ~~**No CSP**~~ | Step 5 | **CLOSED in Step 7** | Nonce-based CSP in `apps/web/src/proxy.ts`, no `unsafe-inline`. Verified: an injected inline `onerror` handler is blocked (`script-src-attr` violation fired). |
| 8 | **Distributed credential stuffing** — per-IP limits do not stop a botnet | Step 5 | When there are real users | Needs per-account lockout or CAPTCHA. Premature with zero users; revisit before launch. |
| 9 | **Service worker cache scoping** — a caching bug could serve one tenant's data to the next user on a shared POS tablet | Step 3 | Phase 2 (offline) | `sw.js` does no caching yet, so there is nothing to leak. Must be designed in when offline lands. |
| ~~11~~ | ~~**No 401-retry on the client**~~ | Step 9 | **CLOSED in Step 10** | `authedFetch` refreshes once on 401 and retries. Single-flight (`refreshOnce`) so concurrent calls cannot double-spend the rotating refresh token and trip reuse detection. Only 401 retries; 403 propagates. |
| 12 | **Multi-tab silent refresh race** (partially mitigated: single-flight now dedupes refreshes *within* a tab; cross-tab remains) — two tabs reloading together may both present the same refresh token; the loser trips reuse detection and both are logged out | Step 9 | Step 10 (POS) | Not reproduced (single-tab verified). Rotation + reuse detection make this structural. Fix is a short reuse leeway server-side, or single-flight refresh via BroadcastChannel. Revisit when POS makes multi-tab realistic. |
| 10 | **Least-privilege role for prod is manual** — `db:setup-app-role` writes to `.env` | Step 4 | Step 20 | Production must source the password from a secret manager, not a generated file. |

## Rules

- An item is closed only when its fix is verified, not when it is written.
- Adding an item is free. Removing one without a test is not.
