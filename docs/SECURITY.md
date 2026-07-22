# Security

How OraOS protects accounts and tenant data, and the operational settings that
keep those protections intact in production. This is a description of the
implemented design, not aspirations — each item points at the code that enforces
it.

**Reporting a vulnerability.** Email the maintainer privately; do not open a
public issue for anything exploitable.

## Authentication

- **Passwords** are hashed with **bcrypt, cost 12** (`auth.service.ts`).
  Registration and password reset use the same hashing; the plaintext is never
  stored or logged.
- **Login is constant-time across outcomes.** A missing user is compared against
  a dummy hash so response timing does not reveal which emails exist. Wrong
  email, wrong password, and disabled account return one identical message
  (`Invalid email or password`); the real reason is recorded server-side only.
- **Tokens.** A short-lived **access JWT** (default 15 min, `HS256`, with issuer
  `oraos` + audience `oraos-api` *verified*, not just signed) and an opaque
  **refresh token** (256-bit CSPRNG, stored only as a SHA-256 hash).
- **Refresh rotation + reuse detection** (`token.service.ts`): each refresh
  rotates the token; presenting an already-rotated token is treated as theft and
  **the whole token family is revoked**.
- **Session epoch** ("sign out everywhere"): revoking all sessions stamps a
  per-user timestamp; any token family that began before it is dead, which closes
  the race where a refresh already in flight could mint a survivor.
- **Password reset** issues a single-use, 30-minute, SHA-256-hashed token, does
  not reveal whether an email exists, and **revokes every session on success**.
- **Invite acceptance** is authenticated by the invite token itself (256-bit,
  hashed, single-use, expiring) and returns the session the same way login does.

## Cookies

- The refresh token is delivered **only** as a cookie:
  `httpOnly; Secure (production); SameSite=Strict; Path=/api/v1/auth`
  (`refresh-cookie.ts`).
- The access token is returned in the JSON body and held **in memory** by the
  web app — never in `localStorage` or a readable cookie. Anything JavaScript can
  read, an XSS payload can steal; the refresh token JS cannot touch.
- `SameSite=Strict` is the CSRF defence for the refresh cookie, which is why web
  and API must be **same-site** (see [DEPLOYMENT.md](DEPLOYMENT.md)).
- Every token-issuing endpoint (login, register, refresh, select-restaurant,
  invite) routes through one shared helper, so the cookie contract cannot drift.

## JWT

- Secret from `JWT_SECRET` (≥32 chars, **no default** — the app will not boot
  without it). Rotating it invalidates every access token immediately.
- Verification asserts `issuer`, `audience`, and `algorithms: ['HS256']`, so a
  token minted by another system with the same secret still fails.
- Claims (`sub`, `email`, `rid` restaurant, `role`, `perms`) are rebuilt from the
  database on every refresh, so a permission or membership change takes effect
  within one access-token lifetime.

## Multi-tenancy & RLS

- Tenant isolation is enforced in **Postgres**, not just the app. Tenant-scoped
  tables have `ENABLE` + `FORCE ROW LEVEL SECURITY` with a `tenant_isolation`
  policy keyed on `current_restaurant_id()` (`prisma/sql/rls.sql`, applied via
  migrations).
- The app connects as the **least-privilege `oraos_api` role** (`NOBYPASSRLS`),
  never the owner (which has `BYPASSRLS` on Neon and would silently ignore every
  policy). `DATABASE_URL_APP` must differ from `DATABASE_URL`, checked at boot.
- `restaurant_id` is set from the **verified JWT** into a transaction-local
  Postgres setting for every query — never taken from request input.
- Authorization above RLS: a `PermissionsGuard` checks `perms` on mutating
  routes; membership for restaurant selection is verified server-side and returns
  `403` identically for "not a member" and "no such restaurant" (no existence
  leak).

## Secrets

- `.env` / `.env.*` are gitignored; only `*.env.example` is tracked. No secrets
  are committed (verified).
- The `oraos_api` password is generated out of band (`db:setup-app-role
  --print`) and piped straight to a secret manager — never written to disk in
  production.
- The mail provider key lives only in `MailService`; it is passed as a header and
  **never logged**.
- Config is validated at boot and fails closed: production requires
  `sslmode=verify-full` on both DB URLs and `https://` for all origins.

## Content Security Policy

- The web app sets a **nonce-based CSP** per request (`apps/web/src/proxy.ts`),
  with `strict-dynamic`, no `unsafe-inline` for scripts, `object-src 'none'`,
  `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, and
  `upgrade-insecure-requests` in production. `connect-src` is scoped to
  `NEXT_PUBLIC_API_URL` (http + ws) so the API and socket are reachable and
  nothing else is.
- The API sets standard security headers via **helmet** (CSP, HSTS,
  `X-Content-Type-Options`, `X-Frame-Options`, referrer policy, …).

## Logging & redaction

- Structured JSON logs (pino). Redaction is centralised: **Authorization and
  cookie headers, `set-cookie`, and password/token/refreshToken bodies are
  censored**, and the invite token that rides in the `/join/:token` URL is masked
  in both the `url` and the parsed `req.params` (`app.module.ts`,
  `common/logging/redact-url.ts`).
- Mail logs carry only `to`/`subject`/status — never the body (which holds reset
  and invite links) and never the API key.
- Errors are logged **once** with a request id; clients get a generic message and
  the request id, never a stack trace (`all-exceptions.filter.ts`).

## Operational recommendations

- **Same-site domains** for web + API, or refresh silently breaks.
- **Set `RESEND_API_KEY` + `MAIL_FROM`** so password-reset emails actually send
  (otherwise they are only logged).
- **Rotate `JWT_SECRET`** on suspected compromise — it signs everyone out.
- **Wire external error alerting** (Sentry or platform log alerts on `level:50`):
  errors are logged but nothing pages an operator yet (BACKLOG).
- **Per-recipient reset throttling**: `forgot-password` is IP-throttled but has
  no per-email cap — an IP-rotating attacker can spam a victim's inbox (nuisance
  only; links are single-use). Consider adding before a public launch.
- **Distributed credential stuffing**: per-IP limits do not stop a botnet; add
  per-account lockout/CAPTCHA before public launch (BACKLOG #8).
- Keep the DB **owner** URL out of app containers where possible; today it is
  present only for the boot-time "must differ" check and is never used to connect.
