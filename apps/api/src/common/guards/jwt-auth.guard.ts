import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { IS_PUBLIC } from '../decorators/auth.decorators';
import type { AccessTokenPayload } from '../../modules/auth/token.service';

/**
 * Registered globally: authentication is on by default and routes opt out with
 * @Public(). The reverse (opt-in) is how endpoints end up unprotected by
 * accident — forgetting a decorator should fail closed, not open.
 *
 * No Passport. It buys strategy plumbing we do not need; @nestjs/jwt plus this
 * guard is the whole job and three fewer dependencies.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const token = extractBearer(req);
    if (!token) throw new UnauthorizedException('Missing access token');

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      // Never echo the reason: expired vs malformed vs bad signature is free
      // information for an attacker.
      throw new UnauthorizedException('Invalid access token');
    }

    // A refresh token must never be usable as an access token. Without this
    // check the longer-lived credential would authenticate API calls.
    if (payload.typ !== 'access') {
      throw new UnauthorizedException('Invalid access token');
    }

    req.tokenPayload = payload;
    return true;
  }
}

function extractBearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' ? value : undefined;
}
