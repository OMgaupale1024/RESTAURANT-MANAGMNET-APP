# OraOS

AI-powered Restaurant Operating System.

- **[Roadmap & session state](docs/ROADMAP.md) — read this first.** Where the build is, working rules, commands, and the gotchas already paid for.
- [Blueprint](docs/BLUEPRINT.md) — product vision, data model, AI phases
- [Architecture](docs/ARCHITECTURE.md) — decisions that constrain all development
- [Backlog](docs/BACKLOG.md) — known gaps, scheduled against the step that owns them

## Structure

```
oraos/
  apps/
    web/            Next.js PWA — landing, login
    api/            NestJS API — auth, Prisma, RLS
    ai/             Python FastAPI       (Step 17 — not created yet)
  packages/
    shared/         types + constants    (created when something is shared)
  docs/
```

`apps/ai` and `packages/shared` do not exist yet. Each is created by the step that first needs it.

## Requirements

- Node >= 22
- pnpm (pinned via `packageManager`)
- PostgreSQL — Neon; see `apps/api/.env.example`
- Python 3.10+ (Step 17 only)

## Setup

```bash
pnpm install
cp apps/api/.env.example apps/api/.env      # fill in DATABASE_URL + JWT_SECRET
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @oraos/api db:migrate
pnpm --filter @oraos/api db:setup-app-role  # writes DATABASE_URL_APP
pnpm --filter @oraos/api db:seed
```

Full command list in [docs/ROADMAP.md](docs/ROADMAP.md).

## Conventions

- Never commit `.env`. Only `.env.example` is tracked.
- Money is integer minor units (paise). No floats.
- `restaurant_id` comes from the verified JWT only — never from request input.
- See `docs/ARCHITECTURE.md` before adding a module.
