import { NextResponse, type NextRequest } from 'next/server';

/**
 * Content Security Policy, nonce-based.
 *
 * This file is `proxy.ts`, not `middleware.ts` — Next 16 renamed it.
 *
 * Why a nonce rather than 'unsafe-inline': Next emits an inline bootstrap
 * script on every page, so a CSP without a nonce would have to allow all
 * inline script — which is precisely the thing CSP exists to stop. A nonce is
 * regenerated per request, so an injected <script> cannot guess it.
 *
 * Cost, accepted deliberately: nonces are applied during server rendering, so
 * every page must be dynamically rendered (see app/layout.tsx). The landing
 * page loses static prerendering. That is the price of a real CSP on an app
 * that handles credentials, and it is worth paying.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';

  // The browser must be allowed to call the API, which is a different origin
  // (different port in dev, likely a subdomain in production). Without this,
  // default-src 'self' silently blocks every login request.
  const apiOrigin = safeOrigin(process.env.NEXT_PUBLIC_API_URL);

  const csp = [
    `default-src 'self'`,
    // 'strict-dynamic' lets nonce-approved scripts load their own chunks, so
    // Next's code-splitting keeps working without whitelisting paths.
    // 'unsafe-eval' is dev-only: React uses eval to rebuild error stacks.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    // The API origin must be reachable by fetch; everything else must not.
    `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ''}`,
    `object-src 'none'`,
    // Stops an injected <base> tag rewriting every relative URL to an
    // attacker's host.
    `base-uri 'self'`,
    // The login form must only ever submit to us.
    `form-action 'self'`,
    // Clickjacking: nobody frames a POS.
    `frame-ancestors 'none'`,
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // Next reads the nonce back out of this header during rendering and applies
  // it to its own script tags.
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);

  // Defence in depth alongside the CSP directives above.
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
}

/** Never let a malformed env var silently widen the policy. */
function safeOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export const config = {
  matcher: [
    {
      // Static assets and image optimisation do not execute script and do not
      // need a per-request nonce.
      source: '/((?!_next/static|_next/image|favicon.ico|icon-|sw.js).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
