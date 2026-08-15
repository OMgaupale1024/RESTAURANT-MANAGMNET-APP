'use client';

import { useState } from 'react';
import { Star } from 'lucide-react';
import { ApiRequestError, updateProduct, type Product } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { useToast } from '@/components/ui/toast';

/**
 * The per-row "Popular" star on the Menu screen. Self-contained (owns the
 * PATCH + toast) so the Menu table only drops it in — a filled brand star when
 * flagged, an outline otherwise. Not colour-alone: the accessible label and
 * aria-pressed carry the state for screen readers.
 */
export function PopularToggle({
  product,
  onChanged,
}: {
  product: Product;
  onChanged: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const popular = product.isPopular;

  async function toggle() {
    if (!accessToken || busy) return;
    setBusy(true);
    try {
      await updateProduct(
        accessToken,
        (t) => setAccessToken(t),
        product.id,
        { isPopular: !popular },
      );
      toast({
        title: popular
          ? `${product.name} removed from Popular`
          : `${product.name} marked Popular`,
        variant: 'success',
      });
      onChanged();
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not update the item',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      aria-pressed={popular}
      title={popular ? 'Popular — tap to unmark' : 'Mark as Popular'}
      aria-label={
        popular
          ? `${product.name} is Popular, tap to unmark`
          : `Mark ${product.name} as Popular`
      }
      onClick={(e) => {
        e.stopPropagation();
        void toggle();
      }}
      className={cn(
        'rounded p-0.5 transition-colors duration-120 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current',
        popular ? 'text-brand' : 'text-ink-3 hover:text-ink-2',
      )}
    >
      <Star aria-hidden className={cn('size-4', popular && 'fill-current')} />
    </button>
  );
}
