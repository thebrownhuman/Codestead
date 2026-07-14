import process from "node:process";

const port = Number(process.argv[2] ?? "3000");
if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
  throw new Error("The E2E server port must be an integer from 1024 to 65535.");
}

// This entry point deliberately binds only to loopback and enables the demo
// authentication bypass only for the local development server. Production
// still fails closed in isApplicationAuthRequired().
process.env.AUTH_REQUIRED = "false";
process.env.NODE_ENV = "development";
// A stable isolated directory keeps E2E away from a developer's live `.next`
// server without making Next append a new port-specific type path to
// tsconfig.json after every run. Playwright already owns this server lifecycle,
// so concurrent E2E commands against the same workspace are intentionally not
// supported.
process.env.LEARNCODING_NEXT_DIST_DIR = ".next-e2e-test";
// Next's typed-environment generator is already exercised by the production
// build. Disabling it here avoids a Windows dev-startup stall before the
// loopback test server binds.
process.env.LEARNCODING_DISABLE_TYPED_ENV = "1";
process.env.NEXT_TELEMETRY_DISABLED = "1";
// Public and server-side auth URLs must use the isolated test origin. Leaving
// either value at the developer's port-3000 URL turns same-origin auth calls
// into CSP-blocked cross-origin requests during Playwright runs.
const testOrigin = `http://127.0.0.1:${port}`;
process.env.APP_URL = testOrigin;
process.env.NEXT_PUBLIC_APP_URL = testOrigin;
process.argv = [
  process.execPath,
  "next",
  "dev",
  // The E2E server favors the mature compiler path. Turbopack dev startup can
  // stall before binding on the supported Windows pilot host, while release
  // builds still exercise the production compiler separately.
  "--webpack",
  "--hostname",
  "127.0.0.1",
  "--port",
  String(port),
];

await import("../node_modules/next/dist/bin/next");
