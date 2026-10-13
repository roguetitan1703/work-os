import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/today',
    name: 'Work OS',
    short_name: 'Work OS',
    description: 'Tasks, notes and alerts',
    start_url: '/today',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      { src: '/icons/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'New task', url: '/today?add=1', icons: [{ src: '/icons/192', sizes: '192x192' }] },
      { name: 'Notes', url: '/notes', icons: [{ src: '/icons/192', sizes: '192x192' }] },
    ],
  };
}
