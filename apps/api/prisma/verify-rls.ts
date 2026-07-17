/**
 * Proves the tenant boundary actually holds, rather than assuming it does.
 *
 * Run: pnpm --filter @oraos/api verify:rls
 *
 * A cross-tenant leak is the one bug that ends a B2B SaaS, so the boundary
 * gets a test that fails loudly. Every assertion here is an attack a real
 * attacker (or a buggy query) would attempt.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

// Must connect as the APP role, not the owner. The owner has BYPASSRLS and
// would sail through every check below while proving nothing.
const appUrl = process.env.DATABASE_URL_APP;
if (!appUrl) {
  console.error('DATABASE_URL_APP is not set. Run: pnpm db:setup-app-role');
  process.exit(1);
}

// Prisma 7 requires an explicit driver adapter.
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: appUrl }),
});

// Owner connection, used only for teardown (disabling append-only triggers).
const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

let failures = 0;

function check(name: string, passed: boolean, detail = '') {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Runs work with a tenant context set, exactly as the app will in Step 5. */
async function asTenant<T>(
  restaurantId: string | null,
  userId: string | null,
  work: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      // set_config(..., true) = LOCAL, scoped to this transaction only.
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.restaurant_id', $1, true)`,
        restaurantId ?? '',
      );
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.user_id', $1, true)`,
        userId ?? '',
      );
      return work(tx as unknown as PrismaClient);
    },
    // Generous: Neon free tier cold-starts its compute, and the endpoint may
    // be far from the developer. Not representative of production latency.
    { maxWait: 20000, timeout: 30000 },
  );
}

/**
 * Test-data teardown. Mirrors the real purge procedure: the append-only
 * triggers must be explicitly disabled, then restored. Never call this on
 * production data.
 */
async function purge(restaurantId: string) {
  // Trigger toggling is DDL and requires the owner — the app role cannot do
  // this, which is exactly right.
  await owner.$executeRawUnsafe(
    `ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only`,
  );
  await owner.$executeRawUnsafe(
    `ALTER TABLE order_events DISABLE TRIGGER order_events_append_only`,
  );
  await owner.$executeRawUnsafe(
    `ALTER TABLE stock_movements DISABLE TRIGGER stock_movements_append_only`,
  );
  await owner.$executeRawUnsafe(
    `ALTER TABLE attendance_events DISABLE TRIGGER attendance_events_append_only`,
  );
  try {
    await owner.restaurant.deleteMany({ where: { id: restaurantId } });
  } finally {
    await owner.$executeRawUnsafe(
      `ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only`,
    );
    await owner.$executeRawUnsafe(
      `ALTER TABLE order_events ENABLE TRIGGER order_events_append_only`,
    );
    await owner.$executeRawUnsafe(
      `ALTER TABLE stock_movements ENABLE TRIGGER stock_movements_append_only`,
    );
    await owner.$executeRawUnsafe(
      `ALTER TABLE attendance_events ENABLE TRIGGER attendance_events_append_only`,
    );
  }
}

async function main() {
  console.log('\nRLS verification\n');

  // --- setup: two tenants, created with RLS bypassed via superuser-free path.
  // Seed rows must be inserted with a tenant context, since RLS is FORCEd.
  const idA = crypto.randomUUID();
  const idB = crypto.randomUUID();

  await asTenant(idA, null, async (tx) => {
    await tx.restaurant.create({
      data: { id: idA, name: 'Tenant A', slug: `a-${Date.now()}` },
    });
    await tx.branch.create({
      data: { restaurantId: idA, name: 'A Main' },
    });
  });

  await asTenant(idB, null, async (tx) => {
    await tx.restaurant.create({
      data: { id: idB, name: 'Tenant B', slug: `b-${Date.now()}` },
    });
    await tx.branch.create({
      data: { restaurantId: idB, name: 'B Main' },
    });
  });

  console.log('Tenant isolation');

  // A sees only itself.
  const aSees = await asTenant(idA, null, (tx) => tx.restaurant.findMany());
  check(
    'tenant A sees exactly 1 restaurant (its own)',
    aSees.length === 1 && aSees[0].id === idA,
    `saw ${aSees.length}`,
  );

  // A cannot read B by id — the classic IDOR attempt.
  const stolen = await asTenant(idA, null, (tx) =>
    tx.restaurant.findUnique({ where: { id: idB } }),
  );
  check('tenant A cannot read tenant B by direct id (IDOR)', stolen === null);

  // A cannot see B's branches.
  const branches = await asTenant(idA, null, (tx) => tx.branch.findMany());
  check(
    'tenant A sees only its own branches',
    branches.length === 1 && branches[0].restaurantId === idA,
    `saw ${branches.length}`,
  );

  // A cannot write a row belonging to B — the WITH CHECK side.
  let forgeBlocked = false;
  try {
    await asTenant(idA, null, (tx) =>
      tx.branch.create({ data: { restaurantId: idB, name: 'forged' } }),
    );
  } catch {
    forgeBlocked = true;
  }
  check('tenant A cannot insert a row owned by tenant B', forgeBlocked);

  // No context at all = no data. Fails closed.
  const noCtx = await asTenant(null, null, (tx) => tx.restaurant.findMany());
  check('missing tenant context returns zero rows (fails closed)', noCtx.length === 0);

  // Without context, writes are refused too.
  let noCtxWriteBlocked = false;
  try {
    await asTenant(null, null, (tx) =>
      tx.restaurant.create({
        data: { name: 'ghost', slug: `ghost-${Date.now()}` },
      }),
    );
  } catch {
    noCtxWriteBlocked = true;
  }
  check('missing tenant context blocks inserts', noCtxWriteBlocked);

  console.log('\nMoney constraints');

  // total must equal subtotal - discount + tax.
  let badTotalBlocked = false;
  try {
    await asTenant(idA, null, async (tx) => {
      const branch = await tx.branch.findFirstOrThrow();
      await tx.order.create({
        data: {
          restaurantId: idA,
          branchId: branch.id,
          orderNumber: 9001,
          subtotalMinor: 10000,
          discountMinor: 0,
          taxMinor: 500,
          totalMinor: 99999, // wrong on purpose
        },
      });
    });
  } catch {
    badTotalBlocked = true;
  }
  check('order with total that does not add up is rejected', badTotalBlocked);

  // Correct arithmetic is accepted.
  let goodTotalAccepted = false;
  try {
    await asTenant(idA, null, async (tx) => {
      const branch = await tx.branch.findFirstOrThrow();
      await tx.order.create({
        data: {
          restaurantId: idA,
          branchId: branch.id,
          orderNumber: 9002,
          subtotalMinor: 10000,
          discountMinor: 1000,
          taxMinor: 450,
          totalMinor: 9450, // 10000 - 1000 + 450
        },
      });
    });
    goodTotalAccepted = true;
  } catch (e) {
    console.log('    (unexpected)', (e as Error).message.split('\n')[0]);
  }
  check('order with correct arithmetic is accepted', goodTotalAccepted);

  // Negative money is refused.
  let negativeBlocked = false;
  try {
    await asTenant(idA, null, async (tx) => {
      const branch = await tx.branch.findFirstOrThrow();
      await tx.order.create({
        data: {
          restaurantId: idA,
          branchId: branch.id,
          orderNumber: 9003,
          subtotalMinor: -100,
          taxMinor: 0,
          totalMinor: -100,
        },
      });
    });
  } catch {
    negativeBlocked = true;
  }
  check('negative order amounts are rejected', negativeBlocked);

  // Discount cannot exceed subtotal (free money bug).
  let overDiscountBlocked = false;
  try {
    await asTenant(idA, null, async (tx) => {
      const branch = await tx.branch.findFirstOrThrow();
      await tx.order.create({
        data: {
          restaurantId: idA,
          branchId: branch.id,
          orderNumber: 9004,
          subtotalMinor: 1000,
          discountMinor: 5000,
          taxMinor: 0,
          totalMinor: -4000,
        },
      });
    });
  } catch {
    overDiscountBlocked = true;
  }
  check('discount larger than subtotal is rejected', overDiscountBlocked);

  console.log('\nAppend-only enforcement');

  const order = await asTenant(idA, null, (tx) =>
    tx.order.findFirstOrThrow({ where: { orderNumber: 9002 } }),
  );

  await asTenant(idA, null, (tx) =>
    tx.orderEvent.create({
      data: {
        restaurantId: idA,
        orderId: order.id,
        type: 'CREATED',
        toStatus: 'DRAFT',
      },
    }),
  );

  let updateBlocked = false;
  try {
    await asTenant(idA, null, (tx) =>
      tx.orderEvent.updateMany({
        where: { orderId: order.id },
        data: { type: 'NOTE_ADDED' },
      }),
    );
  } catch {
    updateBlocked = true;
  }
  check('order_events cannot be UPDATEd', updateBlocked);

  let deleteBlocked = false;
  try {
    await asTenant(idA, null, (tx) =>
      tx.orderEvent.deleteMany({ where: { orderId: order.id } }),
    );
  } catch {
    deleteBlocked = true;
  }
  check('order_events cannot be DELETEd', deleteBlocked);

  await asTenant(idA, null, (tx) =>
    tx.auditLog.create({
      data: {
        restaurantId: idA,
        action: 'test.performed',
        entityType: 'order',
        entityId: order.id,
      },
    }),
  );

  let auditDeleteBlocked = false;
  try {
    await asTenant(idA, null, (tx) =>
      tx.auditLog.deleteMany({ where: { restaurantId: idA } }),
    );
  } catch {
    auditDeleteBlocked = true;
  }
  check('audit_logs cannot be DELETEd (employee covering tracks)', auditDeleteBlocked);

  console.log('\nCatalogue isolation (Step 10)');

  await asTenant(idA, null, (tx) =>
    tx.product.create({
      data: { restaurantId: idA, name: 'A Secret Recipe', priceMinor: 9900 },
    }),
  );
  await asTenant(idB, null, (tx) =>
    tx.product.create({
      data: { restaurantId: idB, name: 'B Dish', priceMinor: 100 },
    }),
  );

  const bProducts = await asTenant(idB, null, (tx) => tx.product.findMany());
  check(
    'tenant B sees only its own products',
    bProducts.length === 1 && bProducts[0].restaurantId === idB,
    `saw ${bProducts.length}`,
  );

  const aProduct = await asTenant(idA, null, (tx) =>
    tx.product.findFirstOrThrow({ where: { name: 'A Secret Recipe' } }),
  );
  const stolenProduct = await asTenant(idB, null, (tx) =>
    tx.product.findUnique({ where: { id: aProduct.id } }),
  );
  check(
    "tenant B cannot read tenant A's product by id (menu is not public)",
    stolenProduct === null,
  );

  let forgedProduct = false;
  try {
    await asTenant(idB, null, (tx) =>
      tx.product.create({
        data: { restaurantId: idA, name: 'forged', priceMinor: 1 },
      }),
    );
  } catch {
    forgedProduct = true;
  }
  check('tenant B cannot insert a product into tenant A', forgedProduct);

  let negativePrice = false;
  try {
    await asTenant(idA, null, (tx) =>
      tx.product.create({
        data: { restaurantId: idA, name: 'neg', priceMinor: -1 },
      }),
    );
  } catch {
    negativePrice = true;
  }
  check('negative product price is rejected by CHECK', negativePrice);

  console.log('\nCustomer PII isolation (Step 12)');

  await asTenant(idA, null, (tx) =>
    tx.customer.create({
      data: { restaurantId: idA, name: 'Private Person', phone: '9876500001' },
    }),
  );
  // The same real human, known to both restaurants. Each keeps its own record.
  await asTenant(idB, null, (tx) =>
    tx.customer.create({
      data: { restaurantId: idB, name: 'Private Person', phone: '9876500001' },
    }),
  );

  const bCustomers = await asTenant(idB, null, (tx) => tx.customer.findMany());
  check(
    'tenant B sees only its own customers',
    bCustomers.length === 1 && bCustomers[0].restaurantId === idB,
    `saw ${bCustomers.length}`,
  );

  const aCustomer = await asTenant(idA, null, (tx) =>
    tx.customer.findFirstOrThrow({ where: { restaurantId: idA } }),
  );
  const stolenCustomer = await asTenant(idB, null, (tx) =>
    tx.customer.findUnique({ where: { id: aCustomer.id } }),
  );
  check(
    "tenant B cannot read tenant A's customer by id (PII)",
    stolenCustomer === null,
  );

  const phoneProbe = await asTenant(idB, null, (tx) =>
    tx.customer.findMany({ where: { phone: '9876500001' } }),
  );
  check(
    'phone lookup never crosses tenants (no enumeration)',
    phoneProbe.length === 1 && phoneProbe[0].restaurantId === idB,
    `saw ${phoneProbe.length}`,
  );

  let malformedPhone = false;
  try {
    await asTenant(idA, null, (tx) =>
      tx.customer.create({
        data: { restaurantId: idA, name: 'Bad', phone: '+91 98765' },
      }),
    );
  } catch {
    malformedPhone = true;
  }
  check('non-digit phone is rejected by CHECK', malformedPhone);

  console.log('\nInventory isolation & ledger (Step 13)');

  const ingA = await asTenant(idA, null, (tx) =>
    tx.ingredient.create({
      data: { restaurantId: idA, name: 'Secret Spice', unit: 'GRAM' },
    }),
  );
  await asTenant(idB, null, (tx) =>
    tx.ingredient.create({
      data: { restaurantId: idB, name: 'B Spice', unit: 'GRAM' },
    }),
  );

  const bIngredients = await asTenant(idB, null, (tx) =>
    tx.ingredient.findMany(),
  );
  check(
    'tenant B sees only its own ingredients',
    bIngredients.length === 1 && bIngredients[0].restaurantId === idB,
    `saw ${bIngredients.length}`,
  );

  const stolenIngredient = await asTenant(idB, null, (tx) =>
    tx.ingredient.findUnique({ where: { id: ingA.id } }),
  );
  check(
    "tenant B cannot read tenant A's ingredient by id",
    stolenIngredient === null,
  );

  await asTenant(idA, null, (tx) =>
    tx.stockMovement.create({
      data: {
        restaurantId: idA,
        ingredientId: ingA.id,
        type: 'PURCHASE',
        quantity: 1000,
      },
    }),
  );

  const bMovements = await asTenant(idB, null, (tx) =>
    tx.stockMovement.findMany(),
  );
  check(
    "tenant B cannot see tenant A's stock movements",
    bMovements.length === 0,
    `saw ${bMovements.length}`,
  );

  let ledgerUpdateBlocked = false;
  try {
    await asTenant(idA, null, (tx) =>
      tx.stockMovement.updateMany({
        where: { ingredientId: ingA.id },
        data: { quantity: 1 },
      }),
    );
  } catch {
    ledgerUpdateBlocked = true;
  }
  check('stock_movements cannot be UPDATEd (ledger is append-only)', ledgerUpdateBlocked);

  let ledgerDeleteBlocked = false;
  try {
    await asTenant(idA, null, (tx) =>
      tx.stockMovement.deleteMany({ where: { ingredientId: ingA.id } }),
    );
  } catch {
    ledgerDeleteBlocked = true;
  }
  check('stock_movements cannot be DELETEd (covering up waste)', ledgerDeleteBlocked);

  let wrongDirection = false;
  try {
    await asTenant(idA, null, (tx) =>
      tx.stockMovement.create({
        data: {
          restaurantId: idA,
          ingredientId: ingA.id,
          // A WASTE that adds stock is always a bug.
          type: 'WASTE',
          quantity: 500,
        },
      }),
    );
  } catch {
    wrongDirection = true;
  }
  check('a WASTE that increases stock is rejected by CHECK', wrongDirection);

  let zeroMovement = false;
  try {
    await asTenant(idA, null, (tx) =>
      tx.stockMovement.create({
        data: {
          restaurantId: idA,
          ingredientId: ingA.id,
          type: 'ADJUSTMENT',
          quantity: 0,
        },
      }),
    );
  } catch {
    zeroMovement = true;
  }
  check('a zero-quantity movement is rejected by CHECK', zeroMovement);

  console.log('\nStaff isolation & attendance ledger (Step 14)');

  const roleA = await prisma.role.findFirstOrThrow({ where: { key: 'CASHIER' } });

  const userA = await prisma.user.create({
    data: {
      email: `rls-a-${Date.now()}@example.com`,
      name: 'A Staff',
      passwordHash: 'x',
    },
  });
  const memA = await asTenant(idA, null, (tx) =>
    tx.membership.create({
      data: { userId: userA.id, restaurantId: idA, roleId: roleA.id },
    }),
  );

  const inviteA = await asTenant(idA, null, (tx) =>
    tx.staffInvite.create({
      data: {
        restaurantId: idA,
        email: `rls-inv-${Date.now()}@example.com`,
        roleId: roleA.id,
        tokenHash: `hash-${Date.now()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    }),
  );

  const bInvites = await asTenant(idB, null, (tx) => tx.staffInvite.findMany());
  check(
    "tenant B cannot see tenant A's staff invites",
    bInvites.length === 0,
    `saw ${bInvites.length}`,
  );

  // The invite-token policy exception must grant exactly ONE row and no more.
  const byToken = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.invite_token_hash', ${inviteA.tokenHash}, true)`;
    return tx.staffInvite.findMany();
  });
  check(
    'holding an invite token reveals exactly that one invite',
    byToken.length === 1 && byToken[0].id === inviteA.id,
    `saw ${byToken.length}`,
  );

  const wrongToken = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.invite_token_hash', ${'not-a-real-hash'}, true)`;
    return tx.staffInvite.findMany();
  });
  check(
    'a wrong invite token reveals nothing (no enumeration)',
    wrongToken.length === 0,
    `saw ${wrongToken.length}`,
  );

  await asTenant(idA, null, (tx) =>
    tx.attendanceEvent.create({
      data: {
        restaurantId: idA,
        membershipId: memA.id,
        type: 'CLOCK_IN',
        at: new Date(),
      },
    }),
  );

  const bAttendance = await asTenant(idB, null, (tx) =>
    tx.attendanceEvent.findMany(),
  );
  check(
    "tenant B cannot see tenant A's attendance",
    bAttendance.length === 0,
    `saw ${bAttendance.length}`,
  );

  let attendanceUpdateBlocked = false;
  try {
    await asTenant(idA, null, (tx) =>
      tx.attendanceEvent.updateMany({
        where: { membershipId: memA.id },
        data: { at: new Date(0) },
      }),
    );
  } catch {
    attendanceUpdateBlocked = true;
  }
  check(
    'attendance cannot be UPDATEd (hours are pay)',
    attendanceUpdateBlocked,
  );

  let attendanceDeleteBlocked = false;
  try {
    await asTenant(idA, null, (tx) =>
      tx.attendanceEvent.deleteMany({ where: { membershipId: memA.id } }),
    );
  } catch {
    attendanceDeleteBlocked = true;
  }
  check('attendance cannot be DELETEd', attendanceDeleteBlocked);

  console.log('\nRaw SQL respects RLS (Step 16 analytics)');

  // Analytics uses $queryRaw for date bucketing. Raw SQL must be as
  // tenant-scoped as the ORM — if RLS did not apply to it, every aggregate
  // would leak. Give A an order, then run analytics' own raw query as B.
  const branchA = await asTenant(idA, null, (tx) =>
    tx.branch.findFirstOrThrow({ where: { restaurantId: idA } }),
  );
  await asTenant(idA, null, (tx) =>
    tx.order.create({
      data: {
        restaurantId: idA,
        branchId: branchA.id,
        orderNumber: 7777,
        status: 'PLACED',
        subtotalMinor: 5000,
        taxMinor: 250,
        totalMinor: 5250,
      },
    }),
  );

  const rawAsB = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.restaurant_id', $1, true)`, idB);
    return tx.$queryRawUnsafe<Array<{ revenue: bigint }>>(
      `SELECT COALESCE(SUM(total_minor),0)::bigint AS revenue FROM orders
       WHERE status NOT IN ('VOIDED','CANCELLED')`,
    );
  });
  check(
    "raw aggregate SQL never sums another tenant's revenue",
    Number(rawAsB[0].revenue) === 0,
    `saw ${rawAsB[0].revenue}`,
  );

  console.log('\nEmail normalisation');

  let upperEmailBlocked = false;
  try {
    await prisma.user.create({
      data: {
        email: 'Mixed.Case@Example.com',
        passwordHash: 'x',
        name: 'test',
      },
    });
  } catch {
    upperEmailBlocked = true;
  }
  check('non-lowercase email is rejected by CHECK', upperEmailBlocked);

  // --- cleanup.
  //
  // Worth noting what this proves: a restaurant CANNOT be hard-deleted while
  // it has audit or order history, because the cascade hits the append-only
  // triggers. That is correct — audit trails outlive tenants, and orders are
  // voided, never deleted. Purging is therefore a deliberate ops procedure
  // that must disable the triggers first, which is exactly the loud, auditable
  // act it should be. Production tenant removal is a soft delete.
  await purge(idA);
  await purge(idB);
  await owner.user.deleteMany({ where: { email: { startsWith: 'rls-a-' } } });

  console.log(
    failures === 0
      ? '\nAll checks passed.\n'
      : `\n${failures} CHECK(S) FAILED — the tenant boundary is not safe.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await owner.$disconnect();
  });
