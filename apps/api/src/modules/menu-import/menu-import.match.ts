import {
  rupeesToMinor,
  type RawMenu,
  type ReviewItem,
  type ReviewMenu,
} from './menu-import.types';

/**
 * Duplicate / price-change / new-item detection (spec §9–§11), as pure
 * functions over the existing catalogue. No I/O, so the whole thing is a unit
 * test away from proof — see menu-import.match.spec.ts.
 */

export type ExistingProduct = { id: string; name: string; priceMinor: number };
export type Match = ReviewItem['match'];

/** Lowercase, strip diacritics and punctuation to spaces, collapse runs. */
export function normalizeName(s: string): string {
  // NFKD splits an accent into base + combining mark; drop the mark so "Crème"
  // folds to "creme" (not "cre me" — the mark would otherwise become a space).
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Bounded Levenshtein. Menu names are short, so the plain DP is plenty. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Same item spelled a little differently — "Paneer Momo" vs "Paneer Momos".
 * Exact after normalisation, or a small edit distance relative to length. Kept
 * deliberately tight so "Veg Momos" and "Paneer Momos" are NOT called the same.
 */
export function similarName(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const d = editDistance(na, nb);
  return d <= 2 && d / Math.max(na.length, nb.length) <= 0.2;
}

/** Classify one scanned item against the existing catalogue. */
export function matchItem(
  name: string,
  priceMinor: number | null,
  existing: ExistingProduct[],
): Match {
  const norm = normalizeName(name);
  const hit =
    existing.find((p) => normalizeName(p.name) === norm) ??
    existing.find((p) => similarName(p.name, name));
  if (!hit) return { kind: 'new' };
  if (priceMinor !== null && priceMinor !== hit.priceMinor) {
    return {
      kind: 'price_change',
      productId: hit.id,
      existingPriceMinor: hit.priceMinor,
    };
  }
  return {
    kind: 'duplicate',
    productId: hit.id,
    existingPriceMinor: hit.priceMinor,
  };
}

/** The action a freshly-detected item defaults to. The user can override it. */
const DEFAULT_ACTION = {
  new: 'create',
  price_change: 'update',
  duplicate: 'skip',
} as const;

/**
 * Turn a validated RawMenu into the working ReviewMenu: convert prices to paise
 * and annotate every item against the existing catalogue. Pure — the caller
 * supplies the existing products.
 */
export function annotate(
  raw: RawMenu,
  existing: ExistingProduct[],
): ReviewMenu {
  let seq = 0;
  return {
    categories: raw.categories.map((c) => ({
      name: c.name,
      items: c.items.map((it): ReviewItem => {
        const priceMinor = rupeesToMinor(it.price);
        const match = matchItem(it.name, priceMinor, existing);
        return {
          id: `s${seq++}`,
          name: it.name,
          priceMinor,
          description: it.description ?? null,
          quantity: it.quantity ?? null,
          variant: it.variant ?? null,
          veg: it.veg ?? null,
          spicy: it.spicy ?? null,
          confidence: it.confidence,
          action: DEFAULT_ACTION[match.kind],
          match,
        };
      }),
    })),
  };
}
