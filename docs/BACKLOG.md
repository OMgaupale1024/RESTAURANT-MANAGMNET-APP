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
| ~~14~~ | ~~**Discounts hardcoded to 0**~~ | Step 10 | **PARTIALLY CLOSED in Step 18** | Coupon discounts now flow through order.discountMinor (server-computed). Manual/ad-hoc line discounts at POS are still not exposed — add if a real till needs them. |
| 15 | **Refunds not implemented** — voiding stops an order but does not reverse a captured payment | Step 11 | When a payments provider exists | The `order.refund` permission is seeded and `payments` supports it, but a refund against CASH/UPI is a counter action, not an API one. |
| ~~16~~ | ~~**No realtime on Orders/Kitchen**~~ | Step 11 | **CLOSED in Step 15** | Socket.IO gateway, per-tenant rooms, JWT-verified on connect. Kitchen board updates live on order.created / order.status_changed. Verified in browser (New column 3->4 with no reload) and by e2e cross-tenant leak test. |

| 17 | **Customer stats are aggregated on read, not materialised** | Step 12 | Step 16 (Analytics) or when a profile is measurably slow | The blueprint calls for `customer_stats`. Correct at a million orders; today a cached counter buys a staleness bug and saves nothing. Postgres aggregates thousands of rows in ms. Revisit with real data volume. |
| 18 | **Phone normalisation is India-only** — drops +91 / leading 0 | Step 12 | First non-Indian tenant | `customers/phone.ts` implements one documented rule. Real international support means libphonenumber and a per-restaurant country. Non-Indian numbers pass through as digits rather than being mangled. |
| 19 | **No customer delete / GDPR erasure** | Step 12 | Before launch in a regulated market | `orders.customerId` is `onDelete: Restrict`, so a customer with history cannot be erased without deciding what happens to the money. Right default; needs an explicit anonymise-in-place path (keep the order, blank the person). |

| 20 | **No supplier or purchase-order tracking** | Step 13 | When procurement is asked for | The roadmap has no Suppliers step and the blueprint treats it as a separate screen. PURCHASE movements record that stock arrived, not who sold it or what it cost. Food-cost reporting needs the cost side. |
| 21 | **No ingredient cost, so no food-cost or margin** | Step 13 | When ingredient cost is added (needs #20) | Analytics (Step 16) covers the revenue side. Margin needs COGS, which needs a per-unit ingredient cost that does not exist yet. Deliberately NOT faked. |
| 22 | **Stock is summed on read, not materialised** | Step 13 | When an ingredient list is measurably slow | Same call as customer stats (#17). `groupBy` keeps it to 2 queries regardless of ingredient count. Revisit with real movement volume, not before. |
| 23 | **Recipes do not handle yield or waste factors** | Step 13 | When a real kitchen complains | A recipe says 50g paneer per plate. It cannot express "1kg paneer yields 900g usable". Trim loss currently has to be recorded as WASTE, which is honest but manual. |

| 24 | **No payroll / wage rates** | Step 14 | When asked | Attendance gives hours; there is no pay rate or salary. Timesheet minutes are the input a payroll step would consume. Additive. |
| 25 | **No shift scheduling** | Step 14 | When asked | Attendance records what happened, not a planned roster. Predictive staffing (blueprint) needs the schedule side. |
| 26 | **Invite email is not delivered** — the link is shown once in-app for manual sharing | Step 14 | Step 20 (email provider) | Deliberate: dodges the email dependency (#1/#2) and matches how Indian restaurants share links (WhatsApp). Auto-delivery is additive once a provider exists. |
| 27 | **No attendance correction UI** — a manager can append a corrected clock event via API but there is no dedicated screen** | Step 14 | When a real manager needs it | The append-only model supports it (recordedBy marks manager-entered events); only the UI affordance is missing. |

| 28 | **Kitchen board refetches on every event** rather than patching state | Step 15 | When order volume is high | Simplest correct approach; the active list is small. At high volume, apply the event payload to local state instead of refetching. |
| 29 | **Socket has no reconnect backoff tuning / offline queue** | Step 15 | Phase 2 (offline) | socket.io default reconnection is on. A kitchen tablet that drops wifi shows "Reconnecting" and refetches on reconnect — fine for now; offline order capture is a separate concern. |

| 30 | **Analytics timezone is hardcoded to IST** | Step 16 | When a non-IST restaurant exists | Day/hour buckets use Asia/Kolkata. Correct for India-first; a per-restaurant timezone is a settings concern (settings module does not exist). Same posture as phone rules (#18). |
| 31 | **No custom date range on analytics** — only presets (today/7d/30d/90d) | Step 16 | Step 19 (Reports) | A real from/to date picker belongs with Reports and export. Presets cover the daily-driver dashboard. |

| 32 | **Python `apps/ai` service not built** — Phase 1+2 (rules + moving average) run in Nest instead | Step 17 | Phase 3+ (regression/XGBoost/Prophet) | DELIBERATE. Standing up a Python service, read-only role, queue and cross-service auth to compute AVG(daily_sales) that SQL does natively would be speculative infra. Python earns its place when a TRAINED model needs it — which needs training data that does not exist yet. Blueprint escalator: each phase ships only when the prior is measurably insufficient. |
| 33 | **No LLM business advisor** (the "ask your data" chat) | Step 17 | After a provider + cost ceiling is chosen (blueprint §14) | Needs an LLM provider decision and the whitelisted-parameterised-query infra from ARCHITECTURE (never text-to-SQL). Deferred rather than half-built. When added: outputs labelled method=LLM, tenant scope injected outside the prompt. |
| 34 | **Forecasts are not persisted, so accuracy is not tracked** | Step 17 | Phase 3+ | Insights recompute live (correct for now, no staleness). Measuring "was the forecast right?" needs a predictions table — which is also what a trained model would need. Build together. |

| 35 | **No marketing campaign delivery** (WhatsApp/email send) | Step 18 | Step 20 (needs a channel) | Segments give the honest "who to contact" list; a campaign with fake "sent" status would violate the no-fabrication rule. Delivery needs WhatsApp Business API / email (same dep as #1/#2/#26). |
| 36 | **Coupon tax treatment: discount is post-tax** (tax on pre-discount lines) | Step 18 | When a tax accountant reviews | total = subtotal - discount + tax, with tax computed on full line values. Defensible for a "₹X off" coupon and never under-charges tax, but Indian GST may want discount to reduce taxable value. Revisit with the tax_rates work. |
| 37 | **maxRedemptions is count-then-insert, not atomic** | Step 18 | If a coupon is heavily contended | A burst of concurrent redemptions could exceed the cap by a small margin (same class as order-number, but no unique index to catch it). Low stakes for coupons; add a counter or advisory lock if it matters. |

## Rules

- An item is closed only when its fix is verified, not when it is written.
- Adding an item is free. Removing one without a test is not.
