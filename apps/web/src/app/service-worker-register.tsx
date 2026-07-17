'use client';

import { useEffect } from 'react';

// Registers /sw.js so the app is installable. Renders nothing.
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // Registration failure must never break the page — the app works
      // without it, it just is not installable.
      console.error('Service worker registration failed:', err);
    });
  }, []);

  return null;
}
