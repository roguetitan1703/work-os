import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Server-side note conversion (blocks <-> markdown) runs BlockNote in plain Node; bundling it
  // into the server-component layer breaks its React context usage.
  serverExternalPackages: ["@blocknote/server-util", "@blocknote/core", "@blocknote/react", "jsdom"],
  // The reset token is in the URL: never leak it as a Referer (the page also sets a <meta name=referrer>).
  async headers() {
    return [{ source: '/login/reset', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] }];
  },
  experimental: {
    // Client router cache: revisiting a page within 30s needs no request; fully prefetched pages
    // (tab bar, Connect tabs, components/preloader.tsx) stay usable for 5 minutes. Our own writes
    // revalidate immediately; Claude's show up on the next prefetch round or on returning to the app.
    staleTimes: { dynamic: 30, static: 300 },
    // Touching/hovering any other link (a project, a mode) fetches the whole page, not just the skeleton.
    dynamicOnHover: true,
  },
};

export default nextConfig;
