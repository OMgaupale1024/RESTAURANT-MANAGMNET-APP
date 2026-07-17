# OraOS — Product & Technical Blueprint

Status: v1. Decisions map only. Implementation lives in Steps 1–20.
Rule: this document constrains later steps. When a step contradicts this file, update this file in the same step or don't do it.

---

## 1. What OraOS is

An AI operating system for restaurants. POS is the data-capture layer, not the product.

The product loop, in order. Every screen answers exactly one:

| Question | Layer | Screens |
|---|---|---|
| What happened? | Recording | POS, Orders, Kitchen |
| Why did it happen? | Analytics | Analytics, Reports |
| What will happen tomorrow? | Forecasting | AI Analytics, Demand |
| What should I do next? | Recommendation | AI Center, Insights |
| Can AI do it for me? | Automation | Automation, Campaigns |

Strategic consequence: the POS must be boring, fast, and correct, because it is the sensor. Bad order data makes every layer above it worthless. Do not put AI in the ordering hot path.

---

## 2. Non-negotiable constraints

These are fixed. Later steps do not relitigate them.

1. **Multi-tenant from row zero.** Every tenant-scoped table carries `restaurant_id`. Tenant identity comes from the JWT, never from a request body, query param, or header. Retrofitting tenancy is a rewrite.
2. **POS works offline.** A restaurant does not stop selling because Wi-Fi dropped. Offline is a Phase 2 build but a day-one architecture.
3. **Money is integers.** Paise, not rupees. No floats anywhere in pricing, tax, or totals. `NUMERIC` in Postgres, integer minor units in TS.
4. **Orders are append-only.** Never `UPDATE` a completed order's totals. Corrections are new rows (void, refund, adjustment). Audit and accounting both depend on this.
5. **No images in Postgres.** Object storage, URLs in DB.
6. **AI never blocks a transaction.** Every model call is async, cached, or precomputed. AI down = restaurant still sells.
7. **Tax logic is data, not code.** GST rates change. Rates live in tables with validity ranges.

---

## 3. System architecture

```
                          ┌──────────────────┐
                          │  Next.js (PWA)   │
                          │  React + TS      │
                          │  IndexedDB queue │
                          └────────┬─────────┘
                                   │ HTTPS / WSS
                          ┌────────▼─────────┐
                          │   NestJS API     │
                          │  auth · tenancy  │
                          │  orders · rbac   │
                          │  Socket.IO       │
                          └──┬──────┬────────┘
                             │      │
              ┌──────────────┘      └──────────────┐
              │                                     │
     ┌────────▼────────┐                  ┌─────────▼────────┐
     │   PostgreSQL    │                  │  Redis           │
     │   (Prisma)      │                  │  cache · queue   │
     └────────┬────────┘                  └─────────┬────────┘
              │                                     │
              │  read-only                          │  jobs
              │                          ┌──────────▼────────┐
              └─────────────────────────►│  Python FastAPI   │
                                         │  forecast · OCR   │
                                         │  LLM advisor      │
                                         └─────────┬─────────┘
                                                   │
                                         ┌─────────▼─────────┐
                                         │  Object storage   │
                                         │  menus · receipts │
                                         └───────────────────┘
```

**Why two backends.** NestJS owns transactions, auth, and correctness. FastAPI owns models, because the ML ecosystem is Python and rewriting XGBoost in TS is a bad trade. The split is along a real seam: Node never trains, Python never writes to an order.

**The rule that keeps the seam clean:** FastAPI gets a **read-only** Postgres role. AI results come back through a queue and are written by Nest, or written by Python only to `predictions` / `ai_*` tables it exclusively owns. Python cannot corrupt transactional data. This is the single most important boundary in the system.

**Why not one backend.** Considered. Rejected: putting model training in the request process of your POS means a slow model call can stall order writes, and a memory-hungry pandas job can OOM the thing taking payments.

**Why not microservices.** Rejected for now. Two services and one database is the correct amount of distribution for a product with zero users. Split further when a specific component has a specific scaling problem, not before.

---

## 4. Multi-tenancy

**Model: shared database, shared schema, `restaurant_id` column, enforced by Row-Level Security.**

Three options were live:

| Model | Isolation | Cost/tenant | Migration pain | Verdict |
|---|---|---|---|---|
| DB per tenant | Highest | Highest | 1000 migrations | No — zero budget |
| Schema per tenant | High | Medium | 1000 schemas | No — Prisma fights it |
| Shared + RLS | Good | Lowest | One migration | **Yes** |

Enforcement is defence in depth, three layers:

1. **App layer** — a Nest interceptor pulls `restaurant_id` from the validated JWT and puts it in a request-scoped context. No handler reads tenant from input.
2. **ORM layer** — a Prisma middleware injects `restaurant_id` into every `where`. Catches the developer who forgot.
3. **Database layer** — Postgres RLS policies on every tenant table, keyed to a session variable Nest sets per connection. Catches the raw query and the compromised app.

Layer 3 is what makes this defensible. Layers 1 and 2 are convenience; RLS is the actual security boundary. A cross-tenant leak is the one bug that ends a B2B SaaS, so it gets three locks.

**Escape hatch:** an enterprise tenant demanding physical isolation later gets their own database with the same schema. Design permits it; don't build it.

---

## 5. Data model — table inventory

Full DDL is **Step 4**. This is the map and the tenancy marking.

`T` = carries `restaurant_id` + RLS.

**Identity & tenancy**
- `restaurants` — the tenant root
- `branches` T — every tenant has ≥1 from day one, even single-location. Retrofitting branches later means rewriting every query.
- `users` — global identity, email unique globally
- `memberships` T — user↔restaurant↔role. A user can work at two restaurants. This is why role is not a column on `users`.
- `roles`, `permissions`, `role_permissions` — RBAC

**Catalogue**
- `categories` T
- `products` T
- `product_variants` T — size/portion
- `modifiers`, `modifier_groups` T — add-ons
- `combos`, `combo_items` T
- `tax_rates` T — validity-dated
- `price_history` T — needed for margin analysis over time

**Transactions**
- `orders` T — partitioned by `created_at` (monthly)
- `order_items` T — **price snapshot at sale time**, not a live FK to product price
- `order_events` T — append-only state log; the timeline UI reads this
- `payments` T — split payment = N rows, one order
- `refunds`, `voids` T

**Customers**
- `customers` T — phone unique *per tenant*, not globally
- `customer_stats` T — materialised, recomputed nightly. Never `COUNT(*)` order history on a profile view.
- `customer_segments` T

**Inventory**
- `suppliers` T
- `ingredients` T
- `recipes` / `recipe_items` T — product→ingredient mapping. This is what makes food-cost and depletion possible; without it inventory is manual forever.
- `stock_movements` T — append-only ledger, not a mutable `quantity` column. Current stock is a sum. This is the same discipline as double-entry accounting and for the same reason.
- `purchase_orders`, `purchase_order_items` T
- `invoices` T — receipt scanner target

**Staff**
- `employees` T, `shifts` T, `attendance` T, `salaries` T

**Intelligence** (Python-owned)
- `predictions` T, `ai_insights` T, `ai_conversations` T, `ai_jobs` T

**Platform**
- `audit_logs` T — append-only, no delete grant even for admin
- `notifications` T, `settings` T, `campaigns` T
- `sync_log` T — offline reconciliation

**Deliberate modelling calls:**
- `order_items` snapshots price/name/tax at sale. A product renamed or repriced tomorrow must not mutate last month's receipts or revenue reports.
- `stock_movements` as a ledger costs a `SUM` on read and buys a complete audit trail and free waste analytics. Cache the balance in Redis if it ever measures slow.
- `customer_stats` denormalised deliberately. RFM and CLV on demand across a million orders is the query that kills the dashboard.

---

## 6. AI architecture

**The escalator.** Each phase ships only when the previous one is measurably insufficient. Every phase is real, shippable value on its own.

| Phase | Model | Used for | Ships when |
|---|---|---|---|
| 1 | Rule-based | Low stock, reorder points, birthday triggers | Day one. Covers ~60% of perceived "AI" value. |
| 2 | Moving average | Tomorrow's demand per item | ~30 days of orders |
| 3 | Linear regression | Demand + weekday/weather features | ~90 days |
| 4 | Random forest | Non-linear demand, churn probability | ~6 months |
| 5 | XGBoost | Production demand + CLV; the workhorse | ~6 months, when RF plateaus |
| 6 | Prophet | Seasonality, festivals, holidays | ~1 year |
| 7 | LSTM | Multi-branch, long-horizon | Only if 5+6 provably fail |

**Honest position on Phase 7:** most restaurant forecasting never needs LSTM. XGBoost + Prophet beats it on this data volume and is a tenth the ops burden. It stays on the roadmap as a research spike, not a commitment.

**Cold start is the real problem, not model choice.** A new restaurant has zero history and needs value on day one. Answer: Phase 1 rules from day one, category priors from similar cuisines, and honest confidence scores. Never show a fabricated forecast — the confidence number is what makes the owner trust the number next to it.

**LLM usage** (the "AI Business Advisor"):
- Owner question → intent parse → **parameterised query against read-only views** → results + schema context → LLM writes prose.
- **The LLM never writes SQL that executes.** It picks from a whitelist of parameterised queries. Text-to-SQL against a live multi-tenant production DB is a cross-tenant data leak with a friendly interface.
- Tenant scope is injected server-side, outside the prompt. A prompt injection must not be able to change which restaurant's data is read.
- Cache aggressively. Same question, same day, same tenant = same answer.

**Vision pipeline** (menu import, receipt scan, inventory count):
```
upload → object storage → queue job → preprocess (deskew, deglare, sharpen)
   → OCR → LLM structure-extraction → confidence score
   → human confirmation UI → commit
```
Human confirmation is mandatory, not a courtesy. An OCR error that silently sets a price to ₹90 instead of ₹190 is a revenue bug that no one notices for a month. Always show the source image next to the extracted field.

---

## 7. Offline

POS only. Nothing else needs it.

- Service worker + IndexedDB. Orders queue locally, sync on reconnect.
- **IDs are client-generated UUIDv7.** Server-assigned IDs cannot work offline. v7 over v4 for index locality.
- Every mutation carries an idempotency key. Sync retries must not double-charge.
- **Conflict resolution is domain-specific, not last-write-wins.** New offline orders never conflict — they're inserts. Stock is a ledger, so concurrent depletions sum correctly with no conflict at all. Only menu edits genuinely conflict, and those are rare, owner-initiated, and safe to resolve last-write-wins with a visible warning.

The ledger and UUID choices are what make offline tractable. That's why they're decided here and not in Phase 2.

---

## 8. Security

Threat model first — who actually attacks this:

| Actor | Wants | Primary control |
|---|---|---|
| Cashier | Void own theft, fake refunds | Append-only orders, audit log, refund permission |
| Competitor tenant | Your data | RLS, JWT tenant scoping |
| Ex-employee | Access after firing | Short access tokens, revocable refresh, membership revocation |
| Opportunist | Any exposed endpoint | Rate limit, validation, Helmet |
| Owner | Fake GST numbers | Immutable audit trail |

Note the top row. **The most likely attacker is a logged-in employee, not an anonymous hacker.** This is why append-only and audit logging are architectural constraints rather than nice-to-haves.

**Auth:** JWT access token 15min, refresh token 7d, refresh rotation with reuse detection (a reused refresh token revokes the family — that's how you detect theft). bcrypt cost 12. Refresh tokens in httpOnly SameSite=Strict cookies; access token in memory, never localStorage.

**Authorisation:** permission-based, not role-name checks. Guards ask "can this membership `order.refund`?" not "is this user a manager?". Role names change; permissions don't.

**Standard controls:** Helmet, CORS allowlist, rate limiting (tight on auth), class-validator DTOs with whitelist + forbidNonWhitelisted, Prisma parameterisation, secrets in env and never in the repo, TLS everywhere, daily automated backups with a **restore drill** — an untested backup is not a backup.

**Per-step gate:** every step ends with an attacker-perspective review of that step's code only.

---

## 9. Scale path

Don't build for 1000 tenants. Build so the path to 1000 exists.

| Tenants | Action |
|---|---|
| 1–50 | Single Postgres, single API. Nothing else. |
| 50–200 | Redis cache, read replica for analytics/AI, background workers |
| 200–1000 | Partition `orders`/`order_events` by month, API horizontal + LB, object storage CDN |
| 1000+ | Shard by `restaurant_id` — only if measured, not anticipated |

Sharding is listed for completeness. Postgres on decent hardware handles a thousand restaurants' order volume. Sharding early is the classic way to buy a distributed-systems problem you didn't have.

---

## 10. Deployment (zero budget → paid)

| Layer | Free tier | Paid step-up |
|---|---|---|
| Frontend | Vercel | Vercel Pro |
| API | Railway / Fly.io | Fly / Render |
| AI | Fly.io (scale-to-zero) | Dedicated + GPU only if training needs it |
| Postgres | Neon / Supabase | Neon Scale / RDS |
| Redis | Upstash | Upstash paid |
| Storage | Cloudflare R2 (no egress fees) | R2 |
| CI/CD | GitHub Actions | same |
| Errors | Sentry | Sentry Team |

R2 specifically because egress fees are how object storage bills surprise you.

Pipeline: PR → typecheck + lint + test + migration dry-run → preview deploy → merge to main → staging → manual gate → prod. **Migrations run as a separate step before app deploy, and every migration must be backward-compatible with the running version** — otherwise deploy = downtime.

---

## 11. Pricing

| Tier | ₹/mo | Line | Gate |
|---|---|---|---|
| Starter | 0 | POS, 1 branch, 100 orders/mo | Acquisition |
| Growth | 1,499 | Unlimited orders, inventory, customers, analytics | The real product |
| AI Pro | 3,999 | Forecasting, advisor, scanners, campaigns | Where margin lives |
| Enterprise | Custom | Multi-branch, API, SLA, dedicated DB | Franchise |

Reasoning: free tier must be genuinely usable or it doesn't seed data — and their order history is what makes their AI Pro upgrade work. AI is the paid tier because it's the only line item with real marginal cost (inference) and the only one competitors can't copy in a quarter. Price on saved waste, not on features: if AI Pro prevents ₹8k/mo of spoilage, ₹3,999 sells itself.

---

## 12. Roadmap

| Phase | Scope | Solo | Team of 3 |
|---|---|---|---|
| 1 | Architecture, schema, auth, tenancy | 3–4 wk | 1.5 wk |
| 2 | POS + offline | 5–6 wk | 2.5 wk |
| 3 | Inventory + recipes | 4 wk | 2 wk |
| 4 | Customers + segmentation | 3 wk | 1.5 wk |
| 5 | Analytics | 3 wk | 1.5 wk |
| 6 | AI (phases 1–3, scanners) | 6–8 wk | 3 wk |
| 7 | Marketing | 3 wk | 1.5 wk |
| 8 | Multi-branch | 4 wk | 2 wk |
| — | **Total** | **~8 months** | **~3.5 months** |

Solo estimates assume part-time reality and include the integration and bug tail that plans always omit. Treat as ranges, not commitments.

**Ship gate:** Phases 1–2 are a sellable product. Get one real restaurant using the POS daily before building Phase 3. Their data is the only thing that makes Phase 6 possible, and their complaints are worth more than the roadmap.

---

## 13. Future features — triaged

Not a wishlist. Sorted by whether they're worth the build.

**High value, do:** WhatsApp ordering (India's actual channel), table QR ordering, waste prediction, business health score, churn prediction, predictive staffing, review sentiment.

**Do later:** online ordering site, customer mobile app, third-party delivery integration, franchise dashboard, public API.

**Question hard:** dynamic pricing (restaurant customers punish visible price volatility — the tech works, the social contract doesn't), competitor menu analysis (scraping is legally grey and the data ages badly), AI accounting assistant (regulated output; wrong numbers here are a liability, not a bug).

---

## 14. Open decisions

- Payments provider (Razorpay vs Cashfree) — deferred to POS phase
- WhatsApp: Business API vs a BSP — pricing dependent
- LLM provider and per-tenant cost ceiling — before Phase 6
- Whether `branches` ships enabled or hidden in Phase 1 (schema present either way)
