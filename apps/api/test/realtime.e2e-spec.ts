/**
 * Realtime (Socket.IO) end-to-end.
 *
 * The tests that matter: a socket is a SEPARATE connection with SEPARATE auth.
 * An unauthenticated socket must be refused, and one tenant must never receive
 * another tenant's order events. This is the leak the per-tenant room design
 * exists to prevent.
 */
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaPg } from '@prisma/adapter-pg';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../src/app.module';
import { PrismaClient } from '../src/generated/prisma/client';

const password = 'correct-horse-battery';
let app: NestExpressApplication;
let baseUrl: string;

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

let ipCounter = 700000;
function api() {
  ipCounter++;
  const ip = `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
  const server = app.getHttpServer();
  return {
    post: (url: string) => request(server).post(url).set('X-Forwarded-For', ip),
    patch: (url: string) =>
      request(server).patch(url).set('X-Forwarded-For', ip),
  };
}

async function newTenant(name: string) {
  const email = `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'RT Owner' })
    .expect(201);
  const cookie = reg.headers['set-cookie'][0].split(';')[0];
  const created = await api()
    .post('/api/v1/restaurants')
    .set('Authorization', `Bearer ${reg.body.accessToken}`)
    .send({ name })
    .expect(201);
  const scoped = await api()
    .post('/api/v1/auth/select-restaurant')
    .set('Authorization', `Bearer ${reg.body.accessToken}`)
    .set('Cookie', cookie)
    .send({ restaurantId: created.body.restaurant.id })
    .expect(200);
  const token = scoped.body.accessToken as string;
  const product = await api()
    .post('/api/v1/products')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Momo', priceMinor: 10000 })
    .expect(201);
  return {
    email,
    token,
    restaurantId: created.body.restaurant.id as string,
    productId: product.body.id as string,
  };
}

/** Opens a socket and resolves once connected, or rejects on connect error. */
function connect(token: string | null): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      transports: ['websocket'],
      auth: token ? { token } : {},
      reconnection: false,
    });
    let settled = false;
    // The server accepts the transport, then handleConnection disconnects an
    // unauthenticated client. So rejection looks like connect-then-immediate-
    // disconnect, not a failed connect. Survive a short grace period = authed.
    socket.on('connect', () => {
      setTimeout(() => {
        if (settled) return;
        settled = true;
        if (socket.connected) resolve(socket);
        else reject(new Error('disconnected'));
      }, 400);
    });
    socket.on('connect_error', (e) => {
      if (!settled) {
        settled = true;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    socket.on('disconnect', () => {
      if (!settled) {
        settled = true;
        reject(new Error('disconnected by server'));
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('connect timeout'));
      }
    }, 8000);
  });
}

/** Resolves with the first event of `name`, or null after `ms`. */
function waitFor<T>(
  socket: Socket,
  name: string,
  ms = 5000,
): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.once(name, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('Realtime (e2e)', () => {
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.use(cookieParser());
    app.set('trust proxy', 1);
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    // Real HTTP + WS server on an ephemeral port so socket.io-client can dial in.
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    for (const t of [
      'audit_logs',
      'order_events',
      'security_events',
      'orders',
      'stock_movements',
    ]) {
      await owner.$executeRawUnsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    }
    try {
      const users = await owner.user.findMany({
        where: { email: { startsWith: 'rt-' } },
        select: { id: true },
      });
      const ms = await owner.membership.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { restaurantId: true },
      });
      const rids = ms.map((m) => m.restaurantId);
      await owner.order.deleteMany({ where: { restaurantId: { in: rids } } });
      await owner.restaurant.deleteMany({ where: { id: { in: rids } } });
      await owner.securityEvent.deleteMany({
        where: { email: { startsWith: 'rt-' } },
      });
      await owner.user.deleteMany({ where: { email: { startsWith: 'rt-' } } });
    } finally {
      for (const t of [
        'audit_logs',
        'order_events',
        'security_events',
        'orders',
        'stock_movements',
      ]) {
        await owner.$executeRawUnsafe(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
      }
      await owner.$disconnect();
    }
    await app.close();
  });

  describe('connection auth', () => {
    it('refuses a socket with no token', async () => {
      await expect(connect(null)).rejects.toBeDefined();
    });

    it('refuses a socket with a forged token', async () => {
      const jwt = require('jsonwebtoken');
      const forged = jwt.sign(
        { sub: 'x', rid: 'y', typ: 'access' },
        'attacker-secret-attacker-secret-32',
        { issuer: 'oraos', audience: 'oraos-api' },
      );
      await expect(connect(forged)).rejects.toBeDefined();
    });

    it('accepts a socket with a valid restaurant-scoped token', async () => {
      const t = await newTenant('RT Connect Cafe');
      const socket = await connect(t.token);
      sockets.push(socket);
      expect(socket.connected).toBe(true);
    });
  });

  describe('per-tenant rooms', () => {
    it('delivers an order event to the placing tenant', async () => {
      const t = await newTenant('RT Own Cafe');
      const socket = await connect(t.token);
      sockets.push(socket);

      const received = waitFor<{ orderNumber: number }>(
        socket,
        'order.created',
      );
      await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ productId: t.productId, quantity: 1 }] })
        .expect(201);

      const evt = await received;
      expect(evt).not.toBeNull();
      expect(evt!.orderNumber).toBe(1);
    });

    it("NEVER delivers one tenant's order to another tenant (the leak)", async () => {
      const a = await newTenant('RT Leak A');
      const b = await newTenant('RT Leak B');

      // B is listening. A places an order. B must hear nothing.
      const bSocket = await connect(b.token);
      sockets.push(bSocket);
      const leaked = waitFor(bSocket, 'order.created', 3000);

      await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ items: [{ productId: a.productId, quantity: 1 }] })
        .expect(201);

      expect(await leaked).toBeNull();
    });

    it('delivers a status change to the kitchen live', async () => {
      const t = await newTenant('RT Status Cafe');
      const socket = await connect(t.token);
      sockets.push(socket);

      const order = await api()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ items: [{ productId: t.productId, quantity: 1 }] })
        .expect(201);

      const received = waitFor<{ status: string }>(
        socket,
        'order.status_changed',
      );
      await api()
        .patch(`/api/v1/orders/${order.body.id}/status`)
        .set('Authorization', `Bearer ${t.token}`)
        .send({ status: 'PREPARING' })
        .expect(200);

      const evt = await received;
      expect(evt).not.toBeNull();
      expect(evt!.status).toBe('PREPARING');
    });
  });
});
