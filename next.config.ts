import type { NextConfig } from "next";

const productionHeaders = process.env.NODE_ENV === "production"
  ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]
  : [];

// Playwright can run beside a developer's live Next server without sharing
// Next's build cache or dev-server lock. Normal development and production
// builds keep using `.next` unless the isolated test launcher opts in.
const isolatedDistDir = process.env.LEARNCODING_NEXT_DIST_DIR?.trim();
const typedEnvironmentEnabled = process.env.LEARNCODING_DISABLE_TYPED_ENV !== "1";

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${process.env.NODE_ENV === "production" ? "" : " ws: wss:"}`,
  "worker-src 'self' blob:",
  "form-action 'self'",
  ...(process.env.NODE_ENV === "production" ? ["upgrade-insecure-requests"] : []),
].join("; ");

const nextConfig: NextConfig = {
  ...(isolatedDistDir ? { distDir: isolatedDistDir } : {}),
  output: "standalone",
  poweredByHeader: false,
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: {
    root: process.cwd()
  },
  experimental: {
    typedEnv: typedEnvironmentEnabled
  },
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-DNS-Prefetch-Control", value: "off" },
        { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ...productionHeaders,
      ]
    }
  ]
};

export default nextConfig;
