import type { NextConfig } from "next";
import path from "path";

const extraOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

const isProduction = process.env.NODE_ENV === "production";

const securityHeaders = [
  // Prevent the app from being embedded in iframes (clickjacking protection).
  { key: "X-Frame-Options", value: "DENY" },
  // Stop browsers from MIME-sniffing the declared Content-Type.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Send only the origin (no path/query) as the Referer to third parties.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Disable camera and microphone access — this app has no need for them.
  { key: "Permissions-Policy", value: "camera=(), microphone=()" },
  // Basic CSP: allow resources from same origin; inline scripts/styles are
  // required by Next.js hydration and the xterm.js terminal widget.
  // connect-src is relaxed to include ws: and wss: for the WebSocket terminal.
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
    ].join("; "),
  },
  // HSTS: only set in production where TLS is provided by nginx.
  ...(isProduction
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  // Prevent webpack from trying to bundle ssh2's native .node binary.
  serverExternalPackages: ["ssh2"],
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Allow HMR and /_next/* requests from hosts listed in ALLOWED_ORIGINS.
  allowedDevOrigins: extraOrigins,
  async headers() {
    return [
      {
        // Apply security headers to every route.
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
