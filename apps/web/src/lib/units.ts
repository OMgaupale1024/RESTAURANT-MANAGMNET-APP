import type { StockUnit } from '@/lib/api';

/**
 * Stock is stored as an integer count of the base unit (grams, millilitres,
 * pieces) for the same reason money is stored in paise. Formatting to kg/l is
 * a display concern only — the value is never parsed back from this string.
 */
export function formatQuantity(base: number, unit: StockUnit): string {
  if (unit === 'PIECE') {
    return `${base} pc`;
  }
  const big = unit === 'GRAM' ? 'kg' : 'l';
  const small = unit === 'GRAM' ? 'g' : 'ml';

  // Below 1000 the base unit reads better: "500 g", not "0.5 kg".
  if (Math.abs(base) < 1000) return `${base} ${small}`;
  // toFixed then trim: 1500 -> "1.5 kg", 2000 -> "2 kg".
  return `${(base / 1000).toFixed(2).replace(/\.?0+$/, '')} ${big}`;
}

export const unitLabel = (unit: StockUnit) =>
  unit === 'GRAM' ? 'grams' : unit === 'MILLILITRE' ? 'ml' : 'pieces';
