import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import {
  getTenantContext,
  type TenantContext,
} from '../context/tenant-context';

/** Marks a route as reachable without authentication. Auth is on by default. */
export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Requires ALL listed permission keys. Checked against the token's claims. */
export const REQUIRED_PERMISSIONS = 'requiredPermissions';
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/**
 * Injects the current TenantContext into a handler.
 *
 * Note there is deliberately no way to inject a restaurantId supplied by the
 * client: the only source is the verified token.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext): TenantContext | undefined =>
    getTenantContext(),
);
