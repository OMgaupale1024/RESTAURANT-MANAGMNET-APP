/**
 * Money is integer paise everywhere. It is formatted only at the very edge,
 * for display — never parsed back from a string, never stored as a float.
 */
export function formatMinor(minor: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(minor / 100);
}

/** Parses a rupee input ("150.50") into paise. Returns null if not valid. */
export function parseRupeesToMinor(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(trimmed)) return null;
  // Avoid float drift: 150.55 * 100 is 15054.999... in binary floating point.
  const [rupees, paise = ''] = trimmed.split('.');
  return Number(rupees) * 100 + Number(paise.padEnd(2, '0'));
}
