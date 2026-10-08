import type { NextConfig } from "next";

const productionHeaders = process.env.NODE_ENV === "production"
  ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]
  : [];

// Playwright can run beside a developer's live Next server without sharing
// Next's build cache or dev-server lock. Normal development and production
// builds keep using `.next` unless the isolated test launcher opts in.
const isolatedDistDir = process.env.LEARNCODING_NEXT_DIST_DIR?.trim();
const typedEnvironmentEnabled = process.env.LEARNCODING_DISABLE_TYPED_ENV !== "1";

const nextConfig: NextConfig = {
  // The floating dev badge covered the sidebar footer; errors still show as overlays.
  devIndicators: false,
  ...(isolatedDistDir ? {
    distDir: isolatedDistDir,
    // The isolated E2E dev server keeps every compiled route alive. Disposing idle
    // routes forces recompiles mid-suite, and those reload pages under test.
    onDemandEntries: { maxInactiveAge: 24 * 60 * 60 * 1000, pagesBufferLength: 1_000 },
  } : {}),
  output: "standalone",
  outputFileTracingIncludes: {
    "/api/certificates/*/pdf": [
      "./src/lib/certificates/fonts/NotoSansDevanagari.ttf",
      "./src/lib/certificates/fonts/OFL.txt",
    ],
  },
  poweredByHeader: false,
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: {
    root: process.cwd()
  },
  experimental: {
    typedEnv: typedEnvironmentEnabled,
    // Next's dev debug channel mistakes Playwright WebKit's fresh loads
    // (responseStart=0) for a Safari cache restore and reloads every page once.
    ...(isolatedDistDir ? { reactDebugChannel: false } : {}),
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
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ...productionHeaders,
      ]
    }
  ]
};

export default nextConfig;
