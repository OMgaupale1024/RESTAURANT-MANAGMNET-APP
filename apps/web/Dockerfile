# syntax=docker/dockerfile:1

# OraOS Web (Next.js) — multi-stage build producing a standalone runtime.
#
# Build context is the REPO ROOT (pnpm workspace):
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com/api/v1 \
#     -t oraos-web .
#
# NEXT_PUBLIC_API_URL is embedded in the browser bundle at BUILD time (it also
# drives the CSP connect-src), so it must be supplied here, not at runtime.

# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------------------
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @oraos/web build

# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN addgroup -S nodejs && adduser -S -G nodejs nodejs
# Standalone output preserves the monorepo layout: server.js lives under
# apps/web/, node_modules at the root. static/ and public/ are NOT bundled by
# Next, so copy them into place explicitly.
COPY --from=build --chown=nodejs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=build --chown=nodejs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nodejs:nodejs /repo/apps/web/public ./apps/web/public
USER nodejs
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
