import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { REQUIRED_PERMISSIONS } from '../decorators/auth.decorators';

/**
 * Permission-based, never role-name based. Guards ask "can this membership
 * order.refund?", not "is this user a MANAGER?" — role names change, and a
 * role-name check is the mistake that makes RBAC unmaintainable.
 *
 * Reads claims off the request, NOT from AsyncLocalStorage.
 *
 * Why that matters (this was a live bug, caught the first time a real
 * permission was enforced): Nest runs guards BEFORE interceptors, so
 * TenantContextInterceptor has not populated ALS yet when this executes. The
 * guard saw an empty context and rejected every permissioned request. The
 * verified token payload is attached by JwtAuthGuard, which runs earlier, so
 * that is the correct source here.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;

    const payload = context.switchToHttp().getRequest<Request>().tokenPayload;
    if (!payload) throw new ForbiddenException('Not authenticated');

    // A permission is meaningless without a tenant to exercise it in.
    if (!payload.rid) {
      throw new ForbiddenException('No restaurant selected');
    }

    const held = payload.perms ?? [];
    const missing = required.filter((p) => !held.includes(p));
    if (missing.length) {
      throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    }
    return true;
  }
}
