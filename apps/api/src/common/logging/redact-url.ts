/**
 * Masks credentials that ride in a URL so they never reach a log.
 *
 * Two shapes leak: the staff-invite token as a path segment
 * (`/api/v1/join/<token>`), and any `token=`/`reset_token=` query parameter.
 * Bodies and headers are handled by pino redaction; the URL is the one place a
 * secret can hide in plain sight in the access log.
 */
export function redactUrl(url: string): string {
  return url
    .replace(/\/join\/[^/?#]+/gi, '/join/[REDACTED]')
    .replace(/([?&](?:token|reset_token|invite)=)[^&#]+/gi, '$1[REDACTED]');
}
