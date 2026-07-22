# Environment Variables

Every variable OraOS reads, where it is read, and what happens if it is wrong.
The API validates its entire environment at boot (`apps/api/src/config/env.ts`)
and **crashes rather than starting insecure** — a missing or malformed value is a
startup failure, not a runtime surprise.

Never commit real values. Only `*.env.example` files are tracked.

## API (`apps/api`)

| Variable | Required | Default | Purpose | Example |
|---|---|---|---|---|
| `NODE_ENV` | no | `development` | `production` turns on the boot guards (verify-full DB, https origins) and JSON logs. | `production` |
| `PORT` | no | `3001` | Port the API listens on. Platforms usually inject this. | `3001` |
| `DATABASE_URL` | **yes** | — | **Owner** role. Migrations and DDL only. On Neon this role has `BYPASSRLS`, so it must never serve app traffic. `sslmode=verify-full` required in production. | `postgresql://owner:pw@host/neondb?sslmode=verify-full` |
| `DATABASE_URL_APP` | **yes** | — | **Least-privilege** `oraos_api` role — all runtime queries, subject to RLS. Must **differ** from `DATABASE_URL` or the app refuses to boot. `sslmode=verify-full` required in production. | `postgresql://oraos_api:pw@host/neondb?sslmode=verify-full` |
| `JWT_SECRET` | **yes** | — | Signs access tokens. ≥32 chars, unique per environment. Rotating it invalidates every access token. | `openssl rand -base64 48` |
| `CORS_ORIGINS` | no | `http://localhost:3000` | Comma-separated browser-origin allowlist (never reflected). Every origin must be `https://` in production. | `https://app.example.com` |
| `WEB_URL` | no | `http://localhost:3000` | Base URL used to build invite and password-reset links. Must be `https://` in production. | `https://app.example.com` |
| `JWT_ACCESS_TTL_SECONDS` | no | `900` | Access-token lifetime. Short by design — an access token cannot be revoked, so this is the blast radius of a stolen one. | `900` |
| `REFRESH_TOKEN_TTL_DAYS` | no | `7` | Refresh-token (and refresh cookie) lifetime. | `7` |
| `LOG_LEVEL` | no | `info` | pino level: `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace`. | `info` |
| `RESEND_API_KEY` | no | — | Enables real email via Resend. Unset ⇒ email is logged, not sent. If set, `MAIL_FROM` becomes required. | `re_xxx` |
| `MAIL_FROM` | conditional | — | Verified sender. Required when `RESEND_API_KEY` is set; must be an address or `Name <addr>`. | `OraOS <noreply@example.com>` |
| `APP_VERSION` | no | package version | Reported by `GET /health`. Set to a release tag or git SHA in the deploy. | `1.0.0` or `d0976a1` |

Cross-field rules enforced at boot: `DATABASE_URL_APP ≠ DATABASE_URL`;
in production both DB URLs need `sslmode=verify-full` and all of `CORS_ORIGINS`
+ `WEB_URL` must be `https://`; `RESEND_API_KEY` without a valid `MAIL_FROM`
fails.

## Web (`apps/web`)

| Variable | Required | Default | Purpose | Example |
|---|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | **yes (prod)** | `http://localhost:3001/api/v1` | API base URL. **Baked into the browser bundle AND the CSP `connect-src` at BUILD time** — it cannot be changed without rebuilding the web image. | `https://api.example.com/api/v1` |

`NEXT_PUBLIC_*` is embedded in client JS — never put a secret here.

## Docker Compose (root `.env`)

Compose reads all of the API variables above, plus:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `API_PORT` | no | `3001` | Host port published for the API container. |
| `WEB_PORT` | no | `3000` | Host port published for the web container. |

`docker-compose.yml` uses `${VAR:?}` for every required value, so `docker
compose up` fails fast with a clear message if one is missing. Start from
[`.env.example`](../.env.example).
