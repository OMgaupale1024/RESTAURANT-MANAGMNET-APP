import type { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import type { IssuedTokens } from './token.service';

/**
 * The one refresh-token cookie, and the one place its contract lives.
 *
 * Every endpoint that issues a token pair — login, register, refresh,
 * select-restaurant, and invite acceptance — MUST route the refresh token
 * through here. It is httpOnly so an XSS payload cannot read it, and the access
 * token (returned in the body) is the only half JavaScript ever touches. Two
 * copies of this logic is a security bug waiting to drift, which is exactly how
 * the invite path came to leak its refresh token in JSON.
 */
export const REFRESH_COOKIE = 'oraos_rt';

export function refreshCookieOptions(config: ConfigService): CookieOptions {
  const days = config.getOrThrow<number>('REFRESH_TOKEN_TTL_DAYS');
  return {
    httpOnly: true, // invisible to JavaScript, so XSS cannot exfiltrate it
    secure: config.get<string>('NODE_ENV') === 'production',
    sameSite: 'strict', // the CSRF defence for this cookie
    // Scoped so the cookie is not attached to every API call — only the auth
    // endpoints that actually need it. Set-Cookie's Path governs when the
    // browser SENDS the cookie, not where it was set, so issuing it from
    // /join works: the browser still returns it to /auth/refresh.
    path: '/api/v1/auth',
    maxAge: days * 24 * 60 * 60 * 1000,
  };
}

/**
 * Sets the refresh token as an httpOnly cookie and returns the JSON-safe body.
 * The refresh token must never appear in the body.
 */
export function respondWithTokens(
  tokens: IssuedTokens,
  res: Response,
  config: ConfigService,
) {
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, refreshCookieOptions(config));
  return {
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn,
    tokenType: 'Bearer' as const,
  };
}

/**
 * cookie-parser types req.cookies as `any`. Narrow it once here rather than
 * letting untyped values spread through the controllers.
 */
export function readRefreshCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.[REFRESH_COOKIE];
}
