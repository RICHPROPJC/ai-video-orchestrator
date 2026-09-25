import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@resvg/resvg-js", "sharp"],
  // crew node_modules is a symlink to the sibling tree. Turbopack rejects it
  // unless the root covers both directories.
  turbopack: { root: path.resolve(__dirname, "..") },
};

export default nextConfig;
