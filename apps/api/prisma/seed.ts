/**
 * Seeds global reference data: roles and permissions.
 *
 * Run: pnpm --filter @oraos/api db:seed
 * Idempotent — safe to re-run after adding a permission.
 *
 * Scope note: this list covers only what exists today (identity + orders).
 * Each later phase adds its own permissions. Inventing permissions for
 * features that do not exist yet is guesswork.
 *
 * Uses the owner connection: roles and permissions are global reference data
 * with no tenant, so there is no RLS context to establish.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const PERMISSIONS: Record<string, string> = {
  'restaurant.read': 'View restaurant profile and settings',
  'restaurant.update': 'Edit restaurant profile and settings',
  'member.read': 'View staff and their roles',
  'member.manage': 'Invite, edit, and remove staff',
  'product.read': 'View the menu',
  'product.manage': 'Add, edit and deactivate menu items',
  'customer.read': 'View customers and their history',
  'customer.manage': 'Add and edit customer records',
  'analytics.read': 'View business analytics',
  'ai.read': 'View AI insights and forecasts',
  'marketing.read': 'View coupons and customer segments',
  'marketing.manage': 'Create and manage coupons',
  'attendance.record': 'Clock yourself in and out',
  'attendance.manage': 'Record attendance for other staff and view timesheets',
  'inventory.read': 'View stock levels and movements',
  'inventory.manage': 'Receive stock, record waste, edit recipes',
  'order.create': 'Take an order',
  'order.read': 'View orders',
  'order.update': 'Change order contents or status',
  'order.void': 'Void an order',
  'order.refund': 'Refund a payment',
  'audit.read': 'View the audit log',
};

// Role -> permission keys. OWNER intentionally gets everything.
const ROLES: Record<string, { name: string; permissions: string[] }> = {
  OWNER: {
    name: 'Owner',
    permissions: Object.keys(PERMISSIONS),
  },
  MANAGER: {
    name: 'Manager',
    permissions: [
      'restaurant.read',
      'member.read',
      'member.manage',
      'analytics.read',
      'ai.read',
      'marketing.read',
      'marketing.manage',
      'attendance.record',
      'attendance.manage',
      'product.read',
      'product.manage',
      'customer.read',
      'customer.manage',
      'inventory.read',
      'inventory.manage',
      'order.create',
      'order.read',
      'order.update',
      'order.void',
      'order.refund',
      'audit.read',
    ],
  },
  CASHIER: {
    name: 'Cashier',
    // Deliberately cannot void or refund: those are the theft vectors, and
    // the blueprint's threat model puts the cashier at the top of the list.
    permissions: [
      'attendance.record',
      'product.read',
      'customer.read',
      'customer.manage',
      'order.create',
      'order.read',
      'order.update',
    ],
  },
  KITCHEN: {
    name: 'Kitchen',
    permissions: [
      'attendance.record',
      'product.read',
      'inventory.read',
      'inventory.manage',
      'order.read',
      'order.update',
    ],
  },
};

async function main() {
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({
      where: { key },
      update: { description },
      create: { key, description },
    });
  }

  for (const [key, { name, permissions }] of Object.entries(ROLES)) {
    const role = await prisma.role.upsert({
      where: { key },
      update: { name },
      create: { key, name },
    });

    const rows = await prisma.permission.findMany({
      where: { key: { in: permissions } },
      select: { id: true },
    });

    // Replace the mapping wholesale so removing a permission from the list
    // above actually revokes it.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: rows.map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });
  }

  const counts = {
    permissions: await prisma.permission.count(),
    roles: await prisma.role.count(),
    mappings: await prisma.rolePermission.count(),
  };
  console.log('Seeded:', counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
