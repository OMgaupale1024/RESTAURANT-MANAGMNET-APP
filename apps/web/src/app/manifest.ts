import type { MetadataRoute } from 'next';

// Next auto-serves this at /manifest.webmanifest and links it in <head>.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'OraOS',
    short_name: 'OraOS',
    description: 'AI Restaurant Operating System',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#facc15',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
