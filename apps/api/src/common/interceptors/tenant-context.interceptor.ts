import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { tenantStorage } from '../context/tenant-context';

/**
 * Puts the verified token's claims into AsyncLocalStorage for the rest of the
 * request.
 *
 * The tenant identity comes from the JWT and nowhere else — not a header, not
 * a query param, not a body field. This is the single most important rule in
 * the codebase: a `restaurantId` accepted from client input is a cross-tenant
 * vulnerability with a friendly justification attached.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const payload = req.tokenPayload;

    if (!payload) return next.handle();

    return new Observable((subscriber) => {
      tenantStorage.run(
        {
          userId: payload.sub,
          restaurantId: payload.rid ?? null,
          membershipId: payload.mid ?? null,
          permissions: payload.perms ?? [],
        },
        () => {
          next.handle().subscribe({
            next: (v) => subscriber.next(v),
            error: (e) => subscriber.error(e),
            complete: () => subscriber.complete(),
          });
        },
      );
    });
  }
}
