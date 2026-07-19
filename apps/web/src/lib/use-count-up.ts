'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Animated counter (DESIGN.md §7): eases from the previous value to `target`
 * in ≤600ms via rAF. First mount counts up from 0. Reduced motion → snaps.
 * Returns an integer — format the result (e.g. formatMinor) at the call site.
 */
export function useCountUp(target: number, duration = 600): number {
  const [value, setValue] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    fromRef.current = target;

    if (
      from === target ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setValue(target);
      return;
    }

    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}
