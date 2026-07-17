import {
  Injectable,
  InternalServerErrorException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import type { Prisma } from '../generated/prisma/client';
import {
  getTenantContext,
  type TenantContext,
} from '../common/context/tenant-context';

/** The client handed to callers inside a tenant-scoped transaction. */
export type TxClient = Prisma.TransactionClient;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService) {
    super({
      adapter: new PrismaPg({
        // DATABASE_URL_APP, never DATABASE_URL. The owner role has BYPASSRLS
        // and would silently disable tenant isolation across the whole app.
        // env validation refuses to boot if the two are equal.
        connectionString: config.getOrThrow<string>('DATABASE_URL_APP'),
      }),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * The current tenant context, or a 500 if there is none.
   *
   * For writes that must name restaurantId explicitly (RLS's WITH CHECK
   * verifies it, but the column still has to be supplied on INSERT). Callers
   * must never take this value from client input — it comes from the JWT.
   */
  requireContext(): TenantContext & { restaurantId: string } {
    const ctx = getTenantContext();
    if (!ctx?.restaurantId) {
      throw new InternalServerErrorException('No restaurant in context');
    }
    return ctx as TenantContext & { restaurantId: string };
  }

  /**
   * Runs work inside a transaction with the tenant context applied, taken from
   * AsyncLocalStorage.
   *
   * Every tenant-scoped query MUST go through this or RLS returns zero rows —
   * the policies read `app.restaurant_id`, which only exists inside this
   * transaction. Forgetting it fails closed and loudly, which is the correct
   * direction to fail: a query returning nothing gets noticed immediately,
   * one returning everything does not.
   */
  async tx<T>(fn: (db: TxClient) => Promise<T>): Promise<T> {
    const ctx = getTenantContext();
    if (!ctx) {
      // A bug, not a client error: it means a handler ran outside the
      // interceptor without using txAs().
      throw new InternalServerErrorException('Tenant context is not set');
    }
    return this.txAs(ctx, fn);
  }

  /**
   * Runs work with an invite token in context, for the public /join routes.
   *
   * The invitee has no account and therefore no tenant, but staff_invites is
   * RLS-protected. The policy grants read access to exactly the one row whose
   * token hash matches this variable — possession of the token IS the
   * authorization, which is what an invite means.
   *
   * Deliberately narrow: this does not set app.restaurant_id, so it opens
   * nothing else. Writes still require a real tenant context.
   */
  async txWithInvite<T>(
    tokenHash: string,
    fn: (db: TxClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (db) => {
      await db.$executeRaw`SELECT set_config('app.invite_token_hash', ${tokenHash}, true)`;
      return fn(db);
    });
  }

  /**
   * Explicit-context variant, for the paths that run before a context can
   * exist — login, for instance, must read a user's memberships in order to
   * discover which restaurant they belong to.
   */
  async txAs<T>(
    ctx: Pick<TenantContext, 'userId' | 'restaurantId'>,
    fn: (db: TxClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (db) => {
      // set_config(..., true) = LOCAL: scoped to this transaction, so a pooled
      // connection cannot leak one request's tenant into the next.
      await db.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId ?? ''}, true)`;
      await db.$executeRaw`SELECT set_config('app.restaurant_id', ${ctx.restaurantId ?? ''}, true)`;
      return fn(db);
    });
  }
}
