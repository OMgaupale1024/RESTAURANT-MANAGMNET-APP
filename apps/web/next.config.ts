import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker runtime image: Next traces the
  // exact files it needs and emits `.next/standalone`, so the container carries
  // a minimal node_modules instead of the whole workspace.
  output: 'standalone',
  // This is a pnpm monorepo; without an explicit root, tracing starts at
  // apps/web and misses hoisted workspace dependencies. Point it at the repo
  // root so the standalone bundle is complete.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
};

export default nextConfig;
