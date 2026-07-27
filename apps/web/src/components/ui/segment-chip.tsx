import { Badge } from './badge';

/** Just the fields needed to render — the full segment also carries `rule`. */
export type SegmentLike = { key: string; label: string };

/**
 * Segment colour identity — presentation only. The segment itself is classified
 * server-side by one shared classifier and arrives on the customer payload;
 * nothing here reclassifies anyone.
 */
export const SEGMENT_VARIANT: Record<
  string,
  'brand' | 'info' | 'success' | 'warning' | 'neutral'
> = {
  VIP: 'brand',
  REGULAR: 'info',
  NEW: 'success',
  LAPSED: 'warning',
};

export function SegmentChip({ segment }: { segment: SegmentLike }) {
  return (
    <Badge variant={SEGMENT_VARIANT[segment.key] ?? 'neutral'}>
      {segment.label}
    </Badge>
  );
}
