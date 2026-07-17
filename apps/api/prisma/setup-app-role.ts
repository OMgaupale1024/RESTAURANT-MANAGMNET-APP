/**
 * Gives the oraos_api role a login password and writes DATABASE_URL_APP to .env.
 *
 * Run once per environment: pnpm --filter @oraos/api db:setup-app-role
 *
 * The password is generated locally, never printed, and never written anywhere
 * except .env (which is gitignored). It cannot live in the migration because
 * migrations are committed to git.
 *
 * In production, do not run this — create the role's password in your secret
 * manager and set DATABASE_URL_APP from there.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

const ENV_PATH = join(__dirname, '..', '.env');

async function main() {
  const ownerUrl = process.env.DATABASE_URL;
  if (!ownerUrl) throw new Error('DATABASE_URL is not set');

  const env = readFileSync(ENV_PATH, 'utf8');
  if (env.includes('DATABASE_URL_APP=')) {
    console.log('DATABASE_URL_APP already present in .env — nothing to do.');
    console.log('Delete that line and re-run to rotate the password.');
    return;
  }

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

  writeFileSync(
    ENV_PATH,
    `${env.trimEnd()}\n\n# Least-privilege runtime role. Written by db:setup-app-role.\n` +
      `# The app connects as this; migrations use DATABASE_URL. Never swap them:\n` +
      `# the owner role has BYPASSRLS and would silently disable tenant isolation.\n` +
      `DATABASE_URL_APP="${url.toString()}"\n`,
  );

  console.log('oraos_api password set. DATABASE_URL_APP written to apps/api/.env.');
  console.log('The password was not printed and exists only in that file.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
