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

/** Compact display for chart labels and axis ticks: ₹1.2k, ₹4.5L. */
export function formatMinorCompact(minor: number): string {
  const r = minor / 100;
  if (r >= 10000000) return `₹${(r / 10000000).toFixed(1).replace(/\.0$/, '')}Cr`;
  if (r >= 100000) return `₹${(r / 100000).toFixed(1).replace(/\.0$/, '')}L`;
  if (r >= 1000) return `₹${(r / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `₹${Math.round(r)}`;
}

/** Parses a rupee input ("150.50") into paise. Returns null if not valid. */
export function parseRupeesToMinor(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(trimmed)) return null;
  // Avoid float drift: 150.55 * 100 is 15054.999... in binary floating point.
  const [rupees, paise = ''] = trimmed.split('.');
  return Number(rupees) * 100 + Number(paise.padEnd(2, '0'));
}
