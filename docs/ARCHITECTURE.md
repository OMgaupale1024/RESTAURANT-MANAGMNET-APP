# OraOS — Architecture (Step 1)

Scope: decisions Steps 2–20 must obey. Topology, tenancy, and data model are in `BLUEPRINT.md` and not repeated here.

---

## 1. Repository strategy

**Monorepo, pnpm workspaces, no build orchestrator yet.**

```
oraos/
  apps/
    web/          Next.js PWA          (Step 3)
    api/          NestJS               (Step 3)
    ai/           Python FastAPI       (Phase 6 — NOT scaffolded now)
  packages/
    shared/       types + constants shared by web & api
  docs/
    BLUEPRINT.md
    ARCHITECTURE.md
```

Why monorepo: one developer, three deployables, one schema. The API contract changes daily in early phases; two repos means every contract change is two PRs and a version bump. Atomic cross-cutting commits are worth more than independent release cadence we don't need.

Why no Turborepo/Nx yet: they solve slow builds and complex task graphs. We have neither. `pnpm -r` covers it. Add Turborepo when a build measurably hurts — it's a config file, not a migration.

Why Python lives here but outside the pnpm workspace: same repo for atomic commits, own toolchain (`uv`/`pip`) because pnpm has no business managing Python deps.

**`apps/ai` is not created until Phase 6.** The contract below is designed now so nothing blocks it later; the service is not built before it has a job to do.

---

## 2. Nest module conventions

One feature = one module. Flat. No layers beyond what Nest already gives.

```
src/modules/orders/
  orders.module.ts
  orders.controller.ts     HTTP only — no business logic
  orders.service.ts        business logic — no HTTP awareness
  dto/                     class-validator input contracts
```

Rules:
- Controllers validate and delegate. If a controller has an `if` about business rules, it's in the wrong file.
- Services never touch `Request`, `Response`, or headers. Tenant context arrives as an argument.
- Cross-module access goes through the other module's **service**, never its repository or Prisma model.
- **No repository layer.** Prisma is already the repository. Wrapping it to "stay database-agnostic" is a pattern in search of a problem — we are never leaving Postgres, and RLS makes that doubly true.
- No CQRS, no event bus, no interfaces with one implementation.

`src/common/` holds what genuinely crosses modules: tenant context, guards, filters, decorators.

---

## 3. Tenant context propagation

The mechanism behind BLUEPRINT §4 layer 1.

```
Request
  → JwtAuthGuard          verify signature, expiry
  → TenantContextInterceptor   extract restaurant_id from validated claims
  → AsyncLocalStorage     request-scoped store
  → Prisma middleware     inject restaurant_id into every where
  → SET LOCAL app.restaurant_id  per transaction → RLS reads it
```

`AsyncLocalStorage` over Nest request-scoped providers: request-scoped DI re-instantiates the dependency tree per request, which is a real performance cost and forces scope to bubble up through every consumer. ALS is Node stdlib, costs nothing, and doesn't infect service constructors.

**Hard rule:** `restaurant_id` is never a controller parameter, never in a DTO, never in a body. If it appears in a DTO, that's a cross-tenant vulnerability in review, not a style note. The only source is the verified JWT.

---

## 4. Nest ↔ Python contract

Fixed now so Phase 6 slots in without redesign.

**Database roles:**
- `neondb_owner` — migrations only (DDL). **Has BYPASSRLS.** Never serves traffic.
- `oraos_api` — application runtime. No BYPASSRLS, so RLS actually applies.
- `oraos_ai` — **read-only on every transactional table**, read/write on `predictions`, `ai_insights`, `ai_jobs`, `ai_conversations` only. Phase 6.

Enforced by Postgres grants, not convention. Python cannot corrupt an order because the database refuses, not because we remembered.

> **Correction (Step 4, verified).** This document originally implied `FORCE ROW
> LEVEL SECURITY` was enough to bind the connecting role. It is not. Neon's
> default `neondb_owner` carries the **BYPASSRLS** attribute, which ignores every
> policy regardless of ENABLE or FORCE. `FORCE` only removes the *ownership*
> exemption; it does nothing about BYPASSRLS.
>
> This produced the worst possible failure mode: `pg_policies` listed correct
> policies, `relforcerowsecurity` was true, and isolation was completely absent.
> Caught only because `prisma/verify-rls.ts` asserted it instead of assuming it.
>
> Therefore the separate `oraos_api` role is not hardening to do later — it is
> load-bearing today. `DATABASE_URL_APP` must never equal `DATABASE_URL`; the
> API refuses to boot if they match.

**Sync calls** (fast, <2s: ask advisor, classify): Nest → HTTP → FastAPI. Internal shared secret header, service not exposed publicly, network-isolated where the host allows.

**Async jobs** (OCR, training, batch forecast):
```
Nest → POST /jobs → FastAPI returns job_id immediately, row in ai_jobs(status=queued)
FastAPI worker processes → writes result to its own tables → status=done
FastAPI → POST /internal/ai/job-complete → Nest → Socket.IO event to tenant room
```

Callback over polling: polling burns queries and adds latency for no benefit. The callback endpoint authenticates the shared secret and **re-reads the result from the database rather than trusting the callback body** — the body is a notification, not a source of truth.

Why not BullMQ: it's Node-native and a Python consumer means fighting its protocol. Python owns its own queue (`arq`) when it needs one. Two queues in two languages beats one queue and a translation layer.

---

## 5. API conventions

- Prefix `/api/v1`. Versioned from the first endpoint — retrofitting a version prefix once mobile clients exist is a breaking change.
- Plural nouns, HTTP verbs. `POST /api/v1/orders`.
- Validation: global `ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`. Unknown properties are rejected, not stripped silently — mass assignment dies here.
- Errors: one global exception filter, one shape.
  ```json
  { "statusCode": 400, "error": "VALIDATION_FAILED",
    "message": "...", "requestId": "uuid" }
  ```
  `requestId` on every request and every log line. Debugging a production issue without a correlation ID means reading timestamps and guessing.
- **Internal errors never leak.** 500s log the stack server-side and return a generic message plus `requestId`. Prisma errors in particular expose schema, constraint names, and column layout.
- Money in responses: integer minor units + explicit currency. Never a formatted string, never a float.

---

## 6. Real-time

Socket.IO on the Nest process. Same auth as HTTP — JWT verified on connection, not just on the handshake's origin.

**Rooms are per tenant: `restaurant:{id}`.** Optionally `restaurant:{id}:kitchen` for KDS.

The failure mode this prevents: a global broadcast leaks one restaurant's live orders to every connected client. Socket auth is skipped constantly in real products because the HTTP layer "already handles auth" — it doesn't; a socket is a separate connection with separate authorisation.

Events are namespaced `order.created`, `order.status_changed`, `ai.insight_ready`.

---

## 7. Configuration

- One `.env` per app. `.env.example` committed with keys and dummy values; real `.env` never committed.
- **Validated at boot, fail fast.** Nest uses `ConfigModule` with a schema; a missing `JWT_SECRET` crashes at startup, not at the first login attempt in production at 9pm.
- Secrets come from the host's secret manager in deployed environments. The repo contains no real credential, ever.
- No `NODE_ENV`-conditional business logic. Environment differences are config values, not branches. A code path that only runs in production is a code path that was never tested.

---

## 8. Shared package

`packages/shared` holds: shared TypeScript types, enums (order status, roles, permissions), and pure constants.

It holds **no runtime dependencies, no framework imports, no logic**. The moment it imports from Nest or React it stops being shared and becomes a coupling.

API response types start hand-written here. When drift between server and client bites, generate from Nest's OpenAPI output — but not before, because codegen is a pipeline to maintain and drift isn't hurting yet.

---

## 9. Logging

Structured JSON, one line per event, `requestId` + `restaurantId` + `userId` on every line. Pino via `nestjs-pino` — Nest's default logger is unstructured and useless for aggregation.

**Never logged:** passwords, tokens, full card data, OTPs. A redaction list is configured at the logger, not left to the discipline of each call site.

---

## 10. Decisions deferred (with trigger)

| Decision | Build when |
|---|---|
| Turborepo | A build is measurably slow |
| OpenAPI codegen | Type drift causes a real bug |
| `apps/ai` scaffold | Phase 6 |
| Redis | Phase 2 offline sync or first cache need |
| Read replica | Analytics queries affect POS latency |

---

## Attacker review — Step 1

No code shipped this step. These are the architecture decisions with security consequences, reviewed adversarially.

**How I'd attack this design:**

1. **Forge tenant identity.** Send `restaurant_id` in a body or header and hope a handler trusts it. → Blocked by §3: the only source is verified JWT claims, and `forbidNonWhitelisted` rejects the extra property outright rather than ignoring it. RLS is the backstop if both fail.
2. **Connect a socket and listen.** Sockets are the classic auth gap — HTTP is guarded, WS isn't. → §6 requires JWT verification on connect and per-tenant rooms. Global emit is the vulnerability; rooms are the fix.
3. **Hit the Python service directly.** If FastAPI is publicly routable and trusts callers, its DB role is my DB role. → §4: shared secret, network isolation, and a read-only role so the blast radius is read-only even on full compromise.
4. **Forge a job-complete callback** with a fabricated result body. → §4: callback re-reads from the database and treats the body as a notification only. The body is untrusted input.
5. **Read errors for schema intel.** Raw Prisma errors name tables, columns, and constraints — free reconnaissance. → §5: generic 500s, details server-side only.
6. **Harvest logs.** Logs leak tokens more often than endpoints do. → §9: redaction at the logger.

**Mistakes this design is most likely to invite:**
- A developer adds `restaurantId` to a DTO "just for this one admin endpoint." This is the single highest-risk mistake in the codebase and must be a review reject.
- Socket handler added without auth because "the guard covers it" — guards do not apply to WS by default.
- `.env` committed. Needs `.gitignore` before the first real secret exists (Step 2/3).
- Shared secret between services checked with `===` — timing-unsafe. Use `crypto.timingSafeEqual` when that code is written.

**Production ready?** As an architecture, yes — the tenancy boundary is defended at three layers and the service seam is enforced by database grants rather than trust. Nothing is provable until code exists. Outstanding before any deploy: `.gitignore` (Step 2), env validation (Step 3), RLS policies (Step 4), refresh rotation (Step 5).

**Manual testing points:** none — no runnable code this step.
