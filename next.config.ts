import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Server-side note conversion (blocks <-> markdown) runs BlockNote in plain Node; bundling it
  // into the server-component layer breaks its React context usage.
  serverExternalPackages: ["@blocknote/server-util", "@blocknote/core", "@blocknote/react", "jsdom"],
  experimental: {
    // Client router cache: revisiting a page within 30s (60s for prefetched tabs) needs no
    // request. Our own writes revalidate immediately; Claude's show up within a minute.
    staleTimes: { dynamic: 30, static: 60 },
  },
};

export default nextConfig;
