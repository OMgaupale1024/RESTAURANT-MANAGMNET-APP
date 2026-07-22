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
import {
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  SelectRestaurantDto,
  VerifyEmailDto,
} from './dto/auth.dto';
import {
  REFRESH_COOKIE,
  readRefreshCookie,
  refreshCookieOptions,
  respondWithTokens,
} from './refresh-cookie';
import { CurrentUser, Public } from '../../common/decorators/auth.decorators';
import type { TenantContext } from '../../common/context/tenant-context';

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
    return respondWithTokens(tokens, res, this.config);
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
    return respondWithTokens(tokens, res, this.config);
  }

  // Always 204, whether or not the email has an account: the response must not
  // reveal which addresses are registered.
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    await this.auth.requestPasswordReset(dto, meta(req));
  }

  // Public: the reset token is the credential; the caller has no session yet.
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    await this.auth.resetPassword(dto, meta(req));
  }

  // Public: the verification token in the email link is the credential.
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  async verifyEmail(@Body() dto: VerifyEmailDto, @Req() req: Request) {
    await this.auth.verifyEmail(dto.token, meta(req));
  }

  // Authenticated: only the logged-in user can ask to re-send their own link.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('resend-verification')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resendVerification(@CurrentUser() ctx: TenantContext) {
    await this.auth.resendVerification(ctx.userId);
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
    const presented = readRefreshCookie(req);
    if (!presented) throw new UnauthorizedException('Missing refresh token');

    try {
      const tokens = await this.auth.refresh(presented, meta(req));
      return respondWithTokens(tokens, res, this.config);
    } catch (e) {
      // Clear the cookie on any failure so a revoked token stops being
      // replayed by the browser on every subsequent request.
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(this.config));
      throw e;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(readRefreshCookie(req), req.tokenPayload?.sub);
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(this.config));
  }

  /**
   * Revokes every session for this user, on every device.
   *
   * NOT @Public(), unlike logout: there the cookie is the credential and only
   * that one token dies. Ending every session for an identity has to prove it
   * IS that identity, so this one goes through the guard.
   */
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(
    @CurrentUser() ctx: TenantContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logoutAll(ctx.userId, meta(req));
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(this.config));
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
      readRefreshCookie(req),
      // Checked against the user's session epoch: a token from before a
      // "sign out everywhere" may not start a new session.
      req.tokenPayload!.iat,
    );
    return respondWithTokens(tokens, res, this.config);
  }

  @Get('me')
  async me(@CurrentUser() ctx: TenantContext) {
    return this.auth.me(ctx.userId);
  }
}

function meta(req: Request) {
  return { userAgent: req.headers['user-agent'], ip: req.ip };
}
