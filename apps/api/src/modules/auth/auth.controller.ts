import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto, SelectRestaurantDto } from './dto/auth.dto';
import type { IssuedTokens } from './token.service';
import { CurrentUser, Public } from '../../common/decorators/auth.decorators';
import type { TenantContext } from '../../common/context/tenant-context';

const REFRESH_COOKIE = 'oraos_rt';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  // Tighter than the global limit: registration is a spam and enumeration
  // surface.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.auth.register(dto, meta(req));
    return this.respond(tokens, res);
  }

  @Public()
  // Login is the credential-stuffing target. 5/min per IP is generous for a
  // human and hostile to a script.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.auth.login(dto, meta(req));
    return this.respond(tokens, res);
  }

  // Public because the access token is expected to be expired here — the
  // refresh cookie is the credential.
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const presented = refreshCookie(req);
    if (!presented) throw new UnauthorizedException('Missing refresh token');

    try {
      const tokens = await this.auth.refresh(presented, meta(req));
      return this.respond(tokens, res);
    } catch (e) {
      // Clear the cookie on any failure so a revoked token stops being
      // replayed by the browser on every subsequent request.
      res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
      throw e;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(refreshCookie(req), req.tokenPayload?.sub);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  /**
   * Swaps the current token for one scoped to a restaurant the user belongs to
   * (backlog #4). Requires authentication; membership is verified server-side.
   */
  @Post('select-restaurant')
  @HttpCode(HttpStatus.OK)
  async selectRestaurant(
    @CurrentUser() ctx: TenantContext,
    @Body() dto: SelectRestaurantDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.auth.selectRestaurant(
      ctx.userId,
      req.tokenPayload!.email,
      dto.restaurantId,
      meta(req),
      // Passed so the existing session's family continues instead of a new one
      // being minted and the old token orphaned.
      refreshCookie(req),
    );
    return this.respond(tokens, res);
  }

  @Get('me')
  async me(@CurrentUser() ctx: TenantContext) {
    return this.auth.me(ctx.userId);
  }

  /**
   * Refresh token goes in an httpOnly cookie; the access token goes in the
   * body for the client to hold in memory.
   *
   * Neither is written to localStorage: anything readable by JavaScript is
   * readable by an XSS payload, and a stolen refresh token is a persistent
   * session.
   */
  private respond(tokens: IssuedTokens, res: Response) {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, this.cookieOptions());
    return {
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
      tokenType: 'Bearer',
    };
  }

  private cookieOptions() {
    const days = this.config.getOrThrow<number>('REFRESH_TOKEN_TTL_DAYS');
    return {
      httpOnly: true, // invisible to JavaScript, so XSS cannot exfiltrate it
      secure: this.config.get<string>('NODE_ENV') === 'production',
      sameSite: 'strict' as const, // the CSRF defence for this cookie
      // Scoped so the cookie is not attached to every API call — only the
      // endpoints that actually need it.
      path: '/api/v1/auth',
      maxAge: days * 24 * 60 * 60 * 1000,
    };
  }
}

/**
 * cookie-parser types req.cookies as `any`. Narrow it once here rather than
 * letting untyped values spread through the controller.
 */
function refreshCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.[REFRESH_COOKIE];
}

function meta(req: Request) {
  return { userAgent: req.headers['user-agent'], ip: req.ip };
}
