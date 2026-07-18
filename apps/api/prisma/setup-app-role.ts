/**
 * Gives the oraos_api role a login password and writes DATABASE_URL_APP to .env.
 *
 * Run once per environment: pnpm --filter @oraos/api db:setup-app-role
 *
 * The password is generated locally, never printed, and never written anywhere
 * except .env (which is gitignored). It cannot live in the migration because
 * migrations are committed to git.
 *
 * Production (BACKLOG #10): do not write a file. Run with `--print` to rotate
 * the password and emit only the DATABASE_URL_APP to stdout, so a deploy script
 * can pipe it straight into a secret manager and it never touches disk:
 *
 *   DATABASE_URL=... pnpm --filter @oraos/api db:setup-app-role -- --print
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

const ENV_PATH = join(__dirname, '..', '.env');
const PRINT_ONLY = process.argv.includes('--print');

/** Rotates the oraos_api login password and returns the app connection URL. */
async function rotate(ownerUrl: string): Promise<string> {
  // URL-safe: this goes into a connection string.
  const password = randomBytes(24).toString('base64url');

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: ownerUrl }),
  });
  try {
    // Identifier is a literal; only the password is interpolated, and it is
    // generated here from randomBytes, not from user input.
    await prisma.$executeRawUnsafe(
      `ALTER ROLE oraos_api WITH LOGIN PASSWORD '${password}'`,
    );
  } finally {
    await prisma.$disconnect();
  }

  // Build the app URL by swapping credentials in the owner URL.
  const url = new URL(ownerUrl);
  url.username = 'oraos_api';
  url.password = password;
  return url.toString();
}

async function main() {
  const ownerUrl = process.env.DATABASE_URL;
  if (!ownerUrl) throw new Error('DATABASE_URL is not set');

  if (PRINT_ONLY) {
    // Only the URL goes to stdout, so `... --print | secret-set` captures
    // exactly the secret and nothing else. Guidance goes to stderr.
    const url = await rotate(ownerUrl);
    process.stderr.write(
      'oraos_api password rotated. The URL below is on stdout only — store it ' +
        'in your secret manager as DATABASE_URL_APP. It is not written to disk.\n',
    );
    process.stdout.write(`${url}\n`);
    return;
  }

  const env = readFileSync(ENV_PATH, 'utf8');
  if (env.includes('DATABASE_URL_APP=')) {
    console.log('DATABASE_URL_APP already present in .env — nothing to do.');
    console.log('Delete that line and re-run to rotate the password.');
    return;
  }

  const url = await rotate(ownerUrl);

  writeFileSync(
    ENV_PATH,
    `${env.trimEnd()}\n\n# Least-privilege runtime role. Written by db:setup-app-role.\n` +
      `# The app connects as this; migrations use DATABASE_URL. Never swap them:\n` +
      `# the owner role has BYPASSRLS and would silently disable tenant isolation.\n` +
      `DATABASE_URL_APP="${url}"\n`,
  );

  console.log('oraos_api password set. DATABASE_URL_APP written to apps/api/.env.');
  console.log('The password was not printed and exists only in that file.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
