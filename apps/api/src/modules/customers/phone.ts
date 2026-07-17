/**
 * Canonical phone form. ONE function, used by every write and every lookup —
 * if the DTO and the search normalise differently, phone stops being an
 * identity and duplicate customers appear.
 *
 * The bug this fixes: stripping non-digits alone turned "+91 98765-43210" into
 * "919876543210" and "9876543210" into "9876543210" — two records for one
 * person, and a cashier typing the number plainly could not find the customer
 * created with a country code.
 *
 * OraOS is India-first (GST, paise, UPI), so the rule is India's: reduce to the
 * 10-digit national number by dropping a leading 91 country code or a leading
 * 0 trunk prefix.
 *
 * ponytail: India-only rule. Real international support means libphonenumber
 * and an explicit country per restaurant — worth it when a non-Indian tenant
 * exists, not before. Numbers that do not look Indian are passed through as
 * digits so nothing is silently mangled.
 */
export function normalizePhone(input: string): string {
  const digits = String(input).replace(/\D/g, '');

  // +91 98765 43210 / 91 98765 43210 -> 9876543210
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }

  // 0 98765 43210 -> 9876543210 (STD trunk prefix)
  if (digits.length === 11 && digits.startsWith('0')) {
    return digits.slice(1);
  }

  return digits;
}
