import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
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
