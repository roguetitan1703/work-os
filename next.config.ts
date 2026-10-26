import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Server-side note conversion (blocks <-> markdown) runs BlockNote in plain Node; bundling it
  // into the server-component layer breaks its React context usage.
  serverExternalPackages: ["@blocknote/server-util", "@blocknote/core", "@blocknote/react", "jsdom"],
  // Old places: More became Menu, Board became Tasks (the query string is carried over).
  async redirects() {
    return [
      { source: '/more', destination: '/menu', permanent: false },
      { source: '/board', destination: '/tasks', permanent: false },
      // Connect merged into Settings (the old tabs map to a section; keys, computers and the Claude connector moved to Claude > Set up; Alerts and Discord to Notifications).
      { source: '/connect', has: [{ type: 'query', key: 'tab', value: 'code|devices' }], destination: '/claude?tab=setup', permanent: false },
      { source: '/connect', has: [{ type: 'query', key: 'tab', value: 'alerts' }], destination: '/settings?section=notifications', permanent: false },
      { source: '/connect', has: [{ type: 'query', key: 'tab', value: 'discord' }], destination: '/settings?section=notifications&open=discord', permanent: false },
      { source: '/connect', has: [{ type: 'query', key: 'tab', value: 'chat|reference' }], destination: '/claude?tab=setup', permanent: false },
      { source: '/connect', destination: '/settings?section=connections', permanent: false },
      // History, Untouched and Archive merged into Review (one page, the segment is ?view=).
      { source: '/history', has: [{ type: 'query', key: 'tab', value: 'activity' }], destination: '/review?view=activity', permanent: false },
      { source: '/history', has: [{ type: 'query', key: 'tab', value: 'archived' }], destination: '/review?view=archive', permanent: false },
      { source: '/history', has: [{ type: 'query', key: 'tab', value: 'trash' }], destination: '/review?view=trash', permanent: false },
      { source: '/history', destination: '/review?view=done', permanent: false },
      { source: '/hidden', destination: '/review?view=stale', permanent: false },
      { source: '/archive', destination: '/review?view=archive', permanent: false },
      { source: '/recovery', destination: '/settings?section=team&open=modes', permanent: false },
    ];
  },
  // No next/image anywhere: /_next/image only passes files through, it never decodes or resizes one.
  images: { unoptimized: true },
  async headers() {
    return [
      // Everything (pages also get a Content-Security-Policy with a nonce from proxy.ts). Never framed; no sniffing;
      // other sites see only the origin. Permissions: what the app uses (passkeys; notifications are not a policy
      // feature) is left alone, the rest is off.
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), midi=(), browsing-topics=()' },
        ],
      },
      // The reset token is in the URL: never leak it as a Referer (the page also sets a <meta name=referrer>). Last, so
      // it wins over the default above.
      { source: '/login/reset', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
    ];
  },
  experimental: {
    // Client router cache: revisiting a page within 30s needs no request; fully prefetched pages
    // (components/preloader.tsx) stay usable for 5 minutes. Our own writes
    // revalidate immediately; Claude's show up on the next prefetch round or on returning to the app.
    staleTimes: { dynamic: 30, static: 300 },
    // Hovering or touching a link must not render a whole page on the server: only the skeleton is
    // prefetched (components/preloader.tsx warms the three main pages instead).
    dynamicOnHover: false,
    // Fewer build workers on a busy PC (the local demo copy); unset everywhere else.
    ...(Number(process.env.NEXT_BUILD_CPUS) > 0 ? { cpus: Number(process.env.NEXT_BUILD_CPUS) } : {}),
  },
};

export default nextConfig;
