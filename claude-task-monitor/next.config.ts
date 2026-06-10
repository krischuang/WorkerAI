import type { NextConfig } from "next";
import path from "path";

const extraOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // Prevent webpack from trying to bundle ssh2's native .node binary.
  serverExternalPackages: ["ssh2"],
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Allow HMR and /_next/* requests from hosts listed in ALLOWED_ORIGINS.
  allowedDevOrigins: extraOrigins,
};

export default nextConfig;
