import { defineConfig, devices } from "@playwright/test";

const requestedPort = Number(process.env.PLAYWRIGHT_PORT ?? "3000");
if (!Number.isInteger(requestedPort) || requestedPort < 1_024 || requestedPort > 65_535) {
  throw new Error("PLAYWRIGHT_PORT must be an integer from 1024 to 65535.");
}
const baseURL = `http://127.0.0.1:${requestedPort}`;

export default defineConfig({
  testDir: "./e2e",
  // Next's development compiler can reload already-open pages when a second
  // worker compiles a cold route. One worker keeps accessibility scans and
  // navigation assertions deterministic on the supported pilot host.
  fullyParallel: false,
  // A cold Windows/webpack compile can consume most of Playwright's 30-second
  // default before the first route is interactive. This is a lifecycle budget;
  // assertion deadlines remain deliberately strict below.
  timeout: 90_000,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["json", { outputFile: "test-results/playwright-results.json" }],
  ],
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL,
    navigationTimeout: 60_000,
    trace: "retain-on-failure"
  },
  webServer: {
    // An explicit port prevents Next from silently moving to another port
    // while Playwright continues testing an unrelated service.
    command: `node scripts/start-e2e-dev-server.mjs ${requestedPort}`,
    url: baseURL,
    env: { AUTH_REQUIRED: "false" },
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === "1",
    timeout: 180_000
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "tablet-safari", use: { ...devices["iPad Mini"] } },
    { name: "small-mobile", use: { ...devices["iPhone SE"], viewport: { width: 320, height: 568 } } },
    { name: "mobile-safari", use: { ...devices["iPhone 14"] } }
  ]
});
