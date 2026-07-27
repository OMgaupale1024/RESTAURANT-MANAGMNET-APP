/**
 * Client-side phone validation, mirroring the server rule (7–15 digits). The
 * server re-validates and normalises regardless — this is the convenience that
 * disables a submit button, never the guarantee.
 *
 * Returns the digits-only form when valid, or null.
 */
export function validPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}
