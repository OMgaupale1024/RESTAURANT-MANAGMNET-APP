# OraOS — Roadmap & Session State

**Purpose:** this file is the source of truth for where the build is. Read it
first in a new session. It exists so progress does not depend on chat history.

**Last updated:** end of Step 20 (2026-07-18).
**Next action:** All roadmap steps 1–20 done. Remaining work is in `BACKLOG.md`
(password reset #1 / email verification #2 need an email-provider decision) and
the Phase 2+ blueprint items (offline, multi-branch). *Do not start until the
user says so.*

---

## Working rules (from the user — these govern every step)

1. **Sequential. One step at a time.** Never build multiple steps together, never jump ahead, never assume the next feature is wanted.
2. **After completing a step, STOP.** Wait for explicit instruction. Do not continue automatically.
3. **Never redesign previous work** unless asked.
4. **Every step ends with a hacker-style security review** of only that step's code, plus manual testing notes.
5. **Minimal functional UI only.** No animations, gradients, glassmorphism, or advanced design. Simple layouts, cards, buttons, typography. Redesign comes later.
6. **Simplest correct solution wins.** No unnecessary abstraction, dependencies, or premature optimisation. Readable and beginner-friendly over clever.
7. **Only generate files for the current step.** No placeholders for future modules.
8. **Do not repeat previous code or explanations.** Assume approved code exists. Show only changed sections unless asked for the whole file.
9. **No emojis, no marketing language, no motivational filler.** Compact but technically complete.
10. **Issues found mid-step go to `BACKLOG.md`**, scheduled against the step that owns them — not fixed on the spot.
11. **No automated tests unless asked** — but a step's own security claims must be verified.

---

## Step status

| # | Step | Status | Notes |
|---|------|--------|-------|
| 1 | Project Architecture | **Done** | `docs/ARCHITECTURE.md` |
| 2 | Folder Structure | **Done** | pnpm monorepo, `apps/*`, `packages/*` |
| 3 | Tech Stack Setup | **Done** | NestJS + Next PWA, env validation, logging |
| 4 | Database Design | **Done** | 12 models, RLS **verified**, 3 migrations |
| 5 | Authentication | **Done** | JWT + refresh rotation, 21 e2e tests pass |
| 6 | Landing Page | **Done** | `/` — header, hero, 3 cards, footer |
| 7 | Login | **Done** | `/login` + nonce CSP, verified in browser |
| 8 | Restaurant Setup | **Done** | `/setup`, security_events; closed backlog #3, #4 |
| 9 | Dashboard (Home) | **Done** | `/dashboard` shell + nav, silent refresh on reload |
| 10 | POS | **Done** | Catalogue + order taking; closed backlog #6, #11 |
| 11 | Orders | **Done** | List, detail, timeline, state-machine transitions, void |
| 12 | Customers | **Done** | CRM, phone identity, order linkage, derived stats |
| 13 | Inventory | **Done** | Stock ledger, recipes, automatic depletion |
| 14 | Employees | **Done** | Invite-based staff, roles, append-only attendance |
| 15 | Kitchen Display | **Done** | Socket.IO per-tenant rooms, live KDS board |
| 16 | Analytics | **Done** | Server-aggregated overview: revenue, top items, payments, peak hours |
| 17 | AI Features | **Done** | Rule-based + statistical insights (Phase 1+2). Python service & LLM advisor deferred with justification |
| 18 | Marketing | **Done** | Coupons with server-computed redemption, deterministic segments |
| 19 | Reports | **Done** | Custom from/to date window over the Analytics aggregation, CSV export. Closed backlog #31 |
| 20 | Deployment | **Done** | Prod config fail-to-boot guards, `verify-full` TLS (#5), graceful shutdown, `/health/ready`, `migrate deploy`, prod secret path + `DEPLOYMENT.md` (#10). #1/#2 deferred — need an email provider |

Companion docs: `BLUEPRINT.md` (product/vision/data model), `ARCHITECTURE.md`
(binding technical decisions), `BACKLOG.md` (deferred issues by step),
`DEPLOYMENT.md` (production runbook).

---

## What exists now

```
apps/api/   NestJS 11 — auth, health, Prisma, RLS
apps/web/   Next 16.2 / React 19.2 / Tailwind 4 — landing, login, PWA
packages/   empty (created when something is actually shared)
docs/       BLUEPRINT, ARCHITECTURE, BACKLOG, ROADMAP
```

**API endpoints:** `GET /api/v1/health`, `GET /api/v1/health/ready`, `POST /api/v1/auth/{register,login,refresh,logout,select-restaurant}`, `GET /api/v1/auth/me`, `POST|GET /api/v1/restaurants`, `POST|GET /api/v1/products` (`?include=all` adds deactivated), `PATCH /api/v1/products/:id`, `POST|GET /api/v1/categories`, `PATCH|DELETE /api/v1/categories/:id`, `PUT /api/v1/categories/order`, `POST|GET /api/v1/orders`, `GET /api/v1/orders/:id`, `GET /api/v1/orders/:id/timeline`, `PATCH /api/v1/orders/:id/status`, `POST|GET /api/v1/customers`, `GET /api/v1/customers/:id`, `GET /api/v1/customers/by-phone/:phone`, `PATCH /api/v1/customers/:id`, `POST|GET /api/v1/ingredients` (`?include=all` adds deactivated), `PATCH /api/v1/ingredients/:id`, `GET /api/v1/ingredients/:id`, `POST /api/v1/ingredients/:id/movements`, `POST /api/v1/ingredients/:id/adjustments`, `GET|PUT /api/v1/products/:id/recipe`, `GET|POST /api/v1/staff/invites`, `DELETE /api/v1/staff/invites/:id`, `GET|PATCH /api/v1/staff`, `POST /api/v1/staff/me/clock`, `POST /api/v1/staff/:id/clock`, `GET /api/v1/staff/timesheet`, `GET|POST /api/v1/join/:token`, `GET /api/v1/analytics/overview`, `GET /api/v1/ai/insights`, `GET|POST /api/v1/marketing/coupons`, `PATCH /api/v1/marketing/coupons/:id`, `GET /api/v1/marketing/segments`, `GET /api/v1/marketing/segments/:key/customers`, `GET /api/v1/reports/sales`.
**Web routes:** `/` (landing), `/login`, `/setup`, `/dashboard`, `/dashboard/menu`, `/dashboard/pos`, `/dashboard/orders`, `/dashboard/customers`, `/dashboard/inventory`, `/dashboard/staff`, `/dashboard/kitchen`, `/dashboard/analytics`, `/dashboard/reports`, `/dashboard/ai`, `/dashboard/marketing`, `/join/[token]`.

**Database (Neon, ap-southeast-1):** `restaurants`, `branches`, `users`,
`roles`, `permissions`, `role_permissions`, `memberships`, `audit_logs`,
`orders`, `order_items`, `order_events`, `payments`, `refresh_tokens`, `security_events`, `categories`, `products`, `customers`, `ingredients`, `stock_movements`, `recipe_items`, `staff_invites`, `attendance_events`, `coupons`, `coupon_redemptions`.
Seeded: 4 roles (OWNER/MANAGER/CASHIER/KITCHEN), 22 permissions, 56 mappings.

---

## Non-negotiables (repeated here because breaking them is expensive)

- **`restaurant_id` comes from the verified JWT only.** Never from a body, query, or header. If it appears in a DTO, that is a cross-tenant vulnerability — reject in review.
- **`DATABASE_URL_APP` ≠ `DATABASE_URL`.** The owner role has `BYPASSRLS` and would silently disable all tenant isolation. The API refuses to boot if they match. Never "fix" a permissions error by swapping them.
- **Every tenant-scoped query goes through `PrismaService.tx()`** (or `txAs()`), which sets `app.restaurant_id` for RLS. Outside it, RLS returns zero rows.
- **Money is integer minor units (paise).** No floats. DB CHECK enforces `total = subtotal - discount + tax`.
- **`audit_logs` and `order_events` are append-only**, enforced by triggers. A restaurant therefore *cannot* be hard-deleted; purging requires disabling triggers (an ops procedure). Tenant removal is a soft delete.
- **Auth is on by default.** `JwtAuthGuard` is global; routes opt out with `@Public()`.
- **The server prices every order.** Order DTOs accept productId + quantity, never a price. A client-supplied price is the classic POS attack.
- **Placed orders are financial records.** DELETE is revoked; money columns are frozen by trigger once status leaves DRAFT. Status may still change.
- **Order status moves only along the whitelist** in `orders/order-status.ts`. Terminal states (COMPLETED/CANCELLED/VOIDED) are dead ends — corrections are new rows, never a status rewind.
- **Voiding requires `order.void`**, checked in addition to `order.update`. A cashier may move an order along but must never make a sale disappear.
- **Phone is customer identity, and normalisation is ONE shared function** (`customers/phone.ts`). Every write and every lookup must use it — if the paths diverge, one person becomes two records and the till cannot find them. India-only rule (drops +91 / leading 0).
- **`customers` is PII.** KITCHEN deliberately holds no customer permission. Phone is unique per tenant, never globally: the same human eats at two restaurants and neither may learn of the other.
- **Stock is SUM(stock_movements), never a column.** There is deliberately no `quantity` on `ingredients`. A counter would be a lie the moment two orders touched it, and it throws away the only question an owner asks — not "how much cheese" but "where did the cheese go". Ledger is append-only.
- **Stock quantities are integers in the base unit** (grams, millilitres, pieces) — same discipline as money. Formatting to kg/l is display only.
- **Movement sign comes from the type, never the client.** CONSUMPTION is server-only: a client that could post one could make stock vanish without a sale.
- **Insufficient stock never blocks a sale.** A restaurant that cannot sell because a database says zero is worse than a negative number the owner can see. Reality wins over bookkeeping.
- **Staff join by invite link, never by an owner setting a password.** The invitee sets their own — keeps every audit entry and void attributable. Token is 256-bit CSPRNG, stored hashed, single-use, expiring. Possession of the token is the authorization (an RLS policy exception, like memberships).
- **Attendance is an append-only ledger; on-shift is DERIVED, never a flag.** Hours are pay, so immutable like money. A forgotten clock-out is corrected by appending, never editing. A cashier cannot backdate or record for others (needs attendance.manage).
- **OWNER is not invitable or assignable via staff routes** — that path would be privilege escalation. Ownership transfer needs its own flow.
- **A socket is a SEPARATE connection with SEPARATE auth.** The realtime gateway verifies the JWT itself on connect and joins each client to exactly ONE room — its own tenant's, from the verified token, never client input. A global broadcast or client-chosen room leaks one restaurant's live feed to all. Events emit AFTER the DB transaction commits.
- **CSP connect-src must list the ws:// origin explicitly** — CSP treats ws/wss as distinct schemes from http/https. Missing it silently blocks the socket.
- **Coupon discounts are computed SERVER-SIDE inside the order transaction** — the client sends only a code, never an amount, so a coupon can never set an arbitrary price. Deterministic rules (validity window, min subtotal, max redemptions, percent cap). Redemptions are append-only. The order money identity total = subtotal - discount + tax is DB-enforced; discount off subtotal, tax on pre-discount lines.
- **Customer segments are deterministic** (VIP/Regular/New/Lapsed) with every rule stated back to the caller — never a black box. Marketing recommendations are advisory only, labelled by method, never the authority for a money decision.
- **AI insights are labelled by method (DETERMINISTIC/STATISTICAL) and carry a `basis`** — the real numbers behind them. No fabrication: a cold-start restaurant gets NO forecast, a thin one is marked LOW confidence. Reuses inventory rules and the voided-exclusion rule. Phase 1 (rules) + Phase 2 (14-day moving average) computed in Nest — no Python service, no LLM (deferred: models need training data that does not exist yet; LLM advisor needs a provider + whitelisted-query infra).
- **Analytics aggregate SERVER-SIDE only** — raw order rows never leave the DB. Voided/cancelled excluded from revenue (same rule as customer stats). Raw $queryRaw for date_trunc runs inside the tenant tx, so RLS applies to it too (verified). Days/hours bucketed in IST (Asia/Kolkata).
- **One session = one token family.** Anything that re-issues a refresh token mid-session must continue the existing family (`rotateForReissue`), never mint a new one — a new family orphans a live token that survives logout.
- **Access token lives in memory only** (`AuthProvider`). Restored after reload via `/auth/refresh`; never localStorage. The client-side route guard is UX, not security — the API + RLS are the boundary.

---

## Commands

```bash
pnpm install

# API
pnpm --filter @oraos/api dev              # :3001
pnpm --filter @oraos/api test:e2e         # 197 tests (needs DB)
pnpm --filter @oraos/api verify:rls       # 35 tenant-isolation checks
pnpm --filter @oraos/api db:migrate
pnpm --filter @oraos/api db:seed
pnpm --filter @oraos/api db:setup-app-role  # once per environment
pnpm --filter @oraos/api db:studio

# Web
pnpm --filter @oraos/web dev              # :3000
pnpm --filter @oraos/web build

# Whole workspace
pnpm typecheck && pnpm build
```

**Dev test account:** `owner@momos.test` / `correct-horse-battery` (no restaurant).
**With a restaurant:** `fam-1784285405@momos.test` / `correct-horse-battery` (Family Test Kitchen).

**Env:** `apps/api/.env` needs `DATABASE_URL`, `DATABASE_URL_APP`, `JWT_SECRET`.
`apps/web/.env.local` needs `NEXT_PUBLIC_API_URL`. Both gitignored; see the
`.env.example` files.

---

## Version control

Every completed step ends with: all tests + lint + typecheck + build green, then a
conventional commit. Milestones get an annotated tag. Never commit broken code.

- Branch: `main`. Remote: `origin` (GitHub) — `main` and tags are pushed.
- `v0.4-pos` — steps 1-10 baseline (POS milestone)
- `v0.5-orders` — step 11 (order lifecycle)
- `v0.6-customers` — step 12 (CRM + order linkage)
- `v0.7-inventory` — step 13 (stock ledger + recipes + depletion)
- `v0.8-staff` — step 14 (invites, roles, attendance ledger)
- `v0.9-kitchen` — step 15 (realtime KDS, per-tenant socket rooms)
- `v0.10-analytics` — step 16 (server-aggregated business analytics)
- `v0.11-ai` — step 17 (rule-based + statistical insights)
- `v0.12-marketing` — step 18 (coupons + deterministic segments)
- `v0.13-reports` — step 19 (custom-range sales report + CSV export)
- `v0.14-deploy` — step 20 (prod config guards, verify-full TLS, graceful shutdown, readiness, deploy runbook)

---

## Gotchas that already cost time — do not rediscover these

**Next 16**
- Middleware is **`proxy.ts`**, not `middleware.ts`. A `middleware.ts` silently does nothing (→ no CSP at all).
- Nonce-based CSP requires **dynamic rendering**; `layout.tsx` sets `force-dynamic` for this reason. Static pages ship without a nonce and break.
- Read `node_modules/next/dist/docs/` before writing Next code — its `AGENTS.md` warns conventions differ from training data.
- `create-next-app` plants a nested `pnpm-workspace.yaml`/lockfile in the app dir (removed) and a `.gitignore` with bare `.env*` that swallows `.env.example` (negation added).

**Prisma 7**
- Driver adapters are **mandatory**: `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`.
- Datasource URL lives in `prisma.config.ts`, not `schema.prisma`.
- Generator emits **ESM by default** — NestJS is CJS. Schema pins `moduleFormat = "cjs"`, `importFileExtension = ""`, output under `src/generated/prisma`.
- Transaction client type is `Prisma.TransactionClient` (not `ITXClientDenyList`).
- Jest needs `NODE_OPTIONS=--experimental-vm-modules` (via `cross-env`) — the client dynamically imports a WASM query compiler.
- Keep `prisma/*.ts` scripts out of `tsconfig.build.json`, or the compile root shifts and the entrypoint moves to `dist/src/main.js`.
- **Unique-violation errors changed shape.** With driver adapters there is no `meta.target`; the constraint name only appears in `meta.driverAdapterError.cause.originalMessage`. Code is still `P2002`.

**Postgres / Neon**
- **The app role cannot check global uniqueness with a SELECT.** RLS hides other tenants' rows, so a check-then-insert always reports "free" and then the insert blows up. Insert-and-catch-P2002 instead (see `restaurants.service.ts`) — which also removes a TOCTOU race.
- **Append-only triggers make FKs with `onDelete: SetNull`/`Cascade` fatal.** Deleting a user tried to UPDATE `security_events` and was refused, making users undeletable. History tables carry no FK (same as `audit_logs.userId`, `order_items.productId`).
- **Test fixtures must use the OWNER connection.** `PrismaService` is the app role, so RLS silently makes teardown deletes do nothing.
- **`neondb_owner` has `BYPASSRLS`.** `ENABLE`/`FORCE ROW LEVEL SECURITY` do nothing against it. This looked fully protected while enforcing nothing. Hence the `oraos_api` role.
- Neon free tier cold-starts; first query can take seconds. Raise transaction timeouts in scripts.
- `pg` currently treats `sslmode=require` as `verify-full` (stricter); changes in pg v9 — backlog #5.

**NestJS**
- **Guards run BEFORE interceptors.** `PermissionsGuard` must read `req.tokenPayload` (set by `JwtAuthGuard`), NOT AsyncLocalStorage — ALS is populated by an interceptor and is still empty at guard time. This silently denied every permissioned request.
- `overrideGuard()` does **not** work on guards registered via `APP_GUARD` + `useClass`. It fails silently.
- `ConfigModule.forRoot({ validate })` runs **at import time**, so tests cannot set env vars after importing `AppModule`.
- `JwtModule` must be exported from `AuthModule` for the global `JwtAuthGuard` to resolve `JwtService`.

**React / Next client**
- **StrictMode double-mounts effects in dev.** An unguarded refresh-on-mount sends the already-rotated token back, which reads as reuse and revokes the whole family — logging the user out on every dev page load. `AuthProvider` guards with a ref.
- **Auth guards must wait for `status !== 'loading'`.** Redirecting on a null token alone bounces the user to /login during every reload while the silent refresh is still in flight.

**Tooling / environment**
- `pnpm start -p 3000` — pnpm eats `-p`. Use `pnpm --filter @oraos/web exec next start -p 3000`.
- Orphaned dev servers squat on ports and serve **stale builds**. If output looks wrong, kill the port before debugging code: `Get-NetTCPConnection -LocalPort 3000 -State Listen` → `Stop-Process`.
- corepack cannot install pnpm (needs admin for `C:\Program Files\nodejs`). pnpm came from `npm install -g pnpm` (user-scoped).
- pnpm 11 requires explicit build approval in `pnpm-workspace.yaml` (`allowBuilds`).
- `'strict-dynamic'` **allows** `createElement('script')` from trusted code — do not "test" CSP that way and conclude it failed. Test inline handlers via `innerHTML` and listen for `securitypolicyviolation`.

---

## Production blockers (must clear before real users)

Step 20 closed the config/TLS/secret-sourcing blockers (see `DEPLOYMENT.md`).
What remains genuinely gates launch:

1. **Password reset (#1)** — a locked-out owner has no recovery path. Needs an email provider (open decision). The one blocker that becomes urgent on day one of a real restaurant.
2. **Email verification (#2)** — same email-provider dependency; lower urgency than #1.

Cleared in Step 20: **`SameSite=Strict` subdomain requirement** — documented in
`DEPLOYMENT.md` as a deploy constraint (`api.`+`app.` under one apex).
**Secret management (#10)** — `db:setup-app-role --print` sources the runtime
password into a secret manager without touching disk; TLS pinned to
`verify-full` (#5). **`oraos_api` UPDATE/DELETE on `orders` (#6)** — closed in
Step 10.
