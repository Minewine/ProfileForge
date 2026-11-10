import type { NextConfig } from "next";

// Deployment: set NEXT_BASE_PATH when building for a subdirectory mount
// (e.g. PassengerBaseURI "/profile-forge" on the shared host). Unset keeps
// local dev, tests and `next start` at the root exactly as before.
const basePath = process.env.NEXT_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  ...(basePath ? { basePath } : {}),
  // Self-contained server (node .next/standalone/server.js) for hosts where
  // we ship a prebuilt bundle instead of running npm install.
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  // Dev-only: allow HMR/dev resources when the dev server is reached from
  // non-localhost origins (e.g. the Docker bridge network). Dev safety block
  // otherwise rejects cross-origin /_next/hmr requests.
  allowedDevOrigins: ["172.17.47.50"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
