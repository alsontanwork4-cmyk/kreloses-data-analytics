import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The e2e suite runs its own `next dev` next to yours, so it builds into its own directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
