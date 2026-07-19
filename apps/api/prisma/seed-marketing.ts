import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function uuid7() {
  // Mock uuid7 for seeding
  return randomUUID();
}

async function main() {
  console.log('Seeding realistic Marketing + AI data...');
  const restaurant = await prisma.restaurant.findFirst();
  if (!restaurant) {
    console.log('No restaurant found to seed data into.');
    return;
  }
  
  const branch = await prisma.branch.findFirst({ where: { restaurantId: restaurant.id } });
  if (!branch) {
      console.log('No branch found');
      return;
  }

  // 1. Create a few coupons
  const coupons = [
    {
      id: uuid7(),
      restaurantId: restaurant.id,
      code: 'WELCOME10',
      type: 'PERCENT' as const,
      percentBp: 1000, // 10%
      maxDiscountMinor: 10000, // max 100 Rs
      minSubtotalMinor: 50000, // min 500 Rs
      maxRedemptions: 100,
      isActive: true,
    },
    {
      id: uuid7(),
      restaurantId: restaurant.id,
      code: 'FLAT50',
      type: 'FIXED' as const,
      amountMinor: 5000, // 50 Rs
      minSubtotalMinor: 20000, // min 200 Rs
      isActive: true,
    },
    {
      id: uuid7(),
      restaurantId: restaurant.id,
      code: 'DIWALI20',
      type: 'PERCENT' as const,
      percentBp: 2000,
      maxRedemptions: 10,
      isActive: true,
    }
  ];

  for (const c of coupons) {
    await prisma.coupon.upsert({
      where: { restaurantId_code: { restaurantId: restaurant.id, code: c.code } },
      update: {},
      create: c,
    });
  }

  const savedCoupons = await prisma.coupon.findMany({ where: { restaurantId: restaurant.id } });
  const cDiwali = savedCoupons.find(c => c.code === 'DIWALI20')!;

  // 2. Create Customers
  const now = new Date();
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  const customersData = [
    { id: uuid7(), restaurantId: restaurant.id, name: 'Alice VIP', phone: '9876543201', email: 'alice@example.com' },
    { id: uuid7(), restaurantId: restaurant.id, name: 'Bob Regular', phone: '9876543202' },
    { id: uuid7(), restaurantId: restaurant.id, name: 'Charlie New', phone: '9876543203' },
    { id: uuid7(), restaurantId: restaurant.id, name: 'Dave Lapsed', phone: '9876543204' },
  ];

  for (const cust of customersData) {
    await prisma.customer.upsert({
      where: { restaurantId_phone: { restaurantId: restaurant.id, phone: cust.phone } },
      update: {},
      create: cust,
    });
  }

  const customers = await prisma.customer.findMany({ where: { restaurantId: restaurant.id } });
  const alice = customers.find(c => c.phone === '9876543201')!;
  const bob = customers.find(c => c.phone === '9876543202')!;
  const charlie = customers.find(c => c.phone === '9876543203')!;
  const dave = customers.find(c => c.phone === '9876543204')!;

  // 3. Create Orders for Segments
  let orderNum = 1000;
  async function createOrder(cId: string, days: number, amountMinor: number, isVoid = false, applyDiwali = false) {
    const o = await prisma.order.create({
      data: {
        id: uuid7(),
        restaurantId: restaurant!.id,
        branchId: branch!.id,
        customerId: cId,
        orderNumber: orderNum++,
        status: isVoid ? 'VOIDED' : 'COMPLETED',
        subtotalMinor: amountMinor,
        taxMinor: Math.floor(amountMinor * 0.05),
        totalMinor: amountMinor + Math.floor(amountMinor * 0.05),
        createdAt: daysAgo(days),
        placedAt: daysAgo(days),
      }
    });

    if (applyDiwali && !isVoid) {
      await prisma.couponRedemption.create({
        data: {
          id: uuid7(),
          restaurantId: restaurant!.id,
          couponId: cDiwali.id,
          orderId: o.id,
          discountMinor: 5000,
          createdAt: daysAgo(days),
        }
      });
    }
  }

  // Alice VIP: >5 visits, >5000 Rs spent
  for(let i=0; i<6; i++) {
    await createOrder(alice.id, i+1, 120000); // 1200 Rs each -> 7200 total
  }
  // Bob Regular: 3-4 visits
  for(let i=0; i<4; i++) {
    await createOrder(bob.id, i*2+1, 30000); 
  }
  // Charlie New: 1-2 visits recently
  await createOrder(charlie.id, 2, 80000, false, true); // Applied coupon
  
  // Dave Lapsed: No visits in 30 days
  for(let i=0; i<3; i++) {
    await createOrder(dave.id, 45 + i, 50000); 
  }

  // Exhaust DIWALI20 for AI Center & Marketing testing (need 10 redemptions)
  for(let i=0; i<9; i++) {
    await createOrder(alice.id, 30, 20000, false, true);
  }

  console.log('Successfully seeded customers, orders, and coupons for Marketing & AI!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
