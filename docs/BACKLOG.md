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

| ~~13~~ | ~~**API lint had never been run**~~ — 119 problems had accumulated | Step 11 | **CLOSED in Step 11** | Only `@oraos/web` lint was being run; earlier steps claimed lint passed on half the workspace. Source errors fixed properly (typed cookie accessor, narrowed `req.id`); the type-aware unsafe-* rules are scoped to tests only, where supertest genuinely returns `any`. Both apps lint clean and it is now part of the pre-commit gate. |
| 14 | **Discounts hardcoded to 0** — no discount UI or API | Step 10 | When asked | `discount_minor` exists with its CHECK (discount <= subtotal) and is in the total formula. Purely additive; nothing is blocked. |
| 15 | **Refunds not implemented** — voiding stops an order but does not reverse a captured payment | Step 11 | When a payments provider exists | The `order.refund` permission is seeded and `payments` supports it, but a refund against CASH/UPI is a counter action, not an API one. |
| 16 | **No realtime on Orders/Kitchen** — the list does not update until reloaded | Step 11 | Step 15 (Kitchen Display) | Socket.IO is in the architecture but unbuilt. A kitchen screen genuinely needs push; an orders list can be reloaded. Build it where it matters. |

| 17 | **Customer stats are aggregated on read, not materialised** | Step 12 | Step 16 (Analytics) or when a profile is measurably slow | The blueprint calls for `customer_stats`. Correct at a million orders; today a cached counter buys a staleness bug and saves nothing. Postgres aggregates thousands of rows in ms. Revisit with real data volume. |
| 18 | **Phone normalisation is India-only** — drops +91 / leading 0 | Step 12 | First non-Indian tenant | `customers/phone.ts` implements one documented rule. Real international support means libphonenumber and a per-restaurant country. Non-Indian numbers pass through as digits rather than being mangled. |
| 19 | **No customer delete / GDPR erasure** | Step 12 | Before launch in a regulated market | `orders.customerId` is `onDelete: Restrict`, so a customer with history cannot be erased without deciding what happens to the money. Right default; needs an explicit anonymise-in-place path (keep the order, blank the person). |

| 20 | **No supplier or purchase-order tracking** | Step 13 | When procurement is asked for | The roadmap has no Suppliers step and the blueprint treats it as a separate screen. PURCHASE movements record that stock arrived, not who sold it or what it cost. Food-cost reporting needs the cost side. |
| 21 | **No ingredient cost, so no food-cost or margin** | Step 13 | Step 16 (Analytics) | Recipes give quantity consumed; without a per-unit cost there is no COGS. Additive: a cost on PURCHASE movements gives weighted-average cost without reshaping anything. |
| 22 | **Stock is summed on read, not materialised** | Step 13 | When an ingredient list is measurably slow | Same call as customer stats (#17). `groupBy` keeps it to 2 queries regardless of ingredient count. Revisit with real movement volume, not before. |
| 23 | **Recipes do not handle yield or waste factors** | Step 13 | When a real kitchen complains | A recipe says 50g paneer per plate. It cannot express "1kg paneer yields 900g usable". Trim loss currently has to be recorded as WASTE, which is honest but manual. |

## Rules

- An item is closed only when its fix is verified, not when it is written.
- Adding an item is free. Removing one without a test is not.
