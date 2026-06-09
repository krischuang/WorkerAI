import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Prevent webpack from trying to bundle ssh2's native .node binary.
  serverExternalPackages: ["ssh2"],
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
