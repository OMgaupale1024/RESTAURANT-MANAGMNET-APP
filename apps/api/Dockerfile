# syntax=docker/dockerfile:1

# OraOS API — multi-stage build for a minimal, non-root production image.
#
# Build context is the REPO ROOT (this is a pnpm workspace):
#   docker build -f apps/api/Dockerfile -t oraos-api .
#
# Stages:
#   build    — full install (incl. native bcrypt), prisma generate, nest build
#   migrator — thin layer over build; runs `prisma migrate deploy` and exits
#   runtime  — prod-only deps + dist, non-root, healthchecked

# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------------------
FROM base AS build
# bcrypt is a native addon; alpine (musl) usually compiles it from source.
RUN apk add --no-cache python3 make g++
# Fetch by lockfile first for a cacheable layer, then install offline.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline
# Generate the Prisma client (compiled into dist by nest build). generate does
# not connect, so a placeholder URL scoped to this step satisfies the config.
RUN DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/db" \
    pnpm --filter @oraos/api exec prisma generate
RUN pnpm --filter @oraos/api build
# Prune to a self-contained production deployment (no devDeps, no prisma CLI).
# --legacy: pnpm 10+ requires it to deploy a non-injected workspace package.
RUN pnpm --filter=@oraos/api --legacy deploy --prod /app

# ---------------------------------------------------------------------------
# Migrations run in their own one-shot container BEFORE the API starts, using
# the owner DATABASE_URL. Reuses the build layers, which carry the prisma CLI,
# schema, and migration history.
FROM build AS migrator
WORKDIR /repo/apps/api
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
# The pruned deployment: package.json + prod node_modules (incl. compiled bcrypt).
COPY --from=build /app ./
# Belt-and-suspenders: guarantee the compiled app and the migration history are
# present regardless of what `pnpm deploy` chose to copy.
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/prisma ./prisma
# Drop root.
RUN addgroup -S nodejs && adduser -S -G nodejs nodejs \
    && chown -R nodejs:nodejs /app
USER nodejs
ENV PORT=3001
EXPOSE 3001
# Liveness: the process is up. No DB touch (that is /health/ready), so a DB blip
# does not get a healthy container killed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# exec form so node is PID 1 and receives SIGTERM directly — enableShutdownHooks
# drains in-flight requests and disconnects Prisma before exit.
CMD ["node", "dist/main.js"]
