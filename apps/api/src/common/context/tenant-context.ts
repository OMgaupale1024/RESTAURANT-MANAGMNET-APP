import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who is making the current request, and on behalf of which tenant.
 *
 * restaurantId is null for a user who is authenticated but has not selected
 * (or does not yet have) a restaurant — e.g. straight after registering,
 * before Step 8's restaurant setup.
 */
export type TenantContext = {
  userId: string;
  restaurantId: string | null;
  membershipId: string | null;
  permissions: string[];
};

/**
 * Request-scoped store.
 *
 * AsyncLocalStorage rather than Nest request-scoped providers: request scoping
 * re-instantiates the dependency tree per request and forces the scope to
 * bubble up through every consumer. ALS is Node stdlib, costs nothing, and
 * does not infect service constructors.
 */
export const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function getTenantContext(): TenantContext | undefined {
  return tenantStorage.getStore();
}
