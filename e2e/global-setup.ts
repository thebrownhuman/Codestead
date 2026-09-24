import { chromium, type FullConfig } from "@playwright/test";

// `next dev` compiles each route on its first request and then reloads the page it
// served. Visiting every route the specs use before any test starts moves those
// compile-and-reload cycles out of the tests, where they otherwise reset open
// drawers, focus and axe scans on slower machines.
const WARM_ROUTES = [
  "/",
  "/admin/certificates",
  "/admin/curriculum",
  "/admin/requests",
  "/career",
  "/community",
  "/courses",
  "/courses/git-tooling/skills/git.branches.merge",
  "/courses/python",
  "/courses/python/skills/python.toolchain.repl",
  "/exams",
  "/forgot-password",
  "/learn",
  "/login",
  "/lost-device",
  "/playground",
  "/projects",
  "/request-access",
  "/requests",
  "/reset-password",
  "/review",
  "/roadmap",
  "/settings",
  "/tutor",
] as const;

const QUIET_MS = 1_500;
const ROUTE_LIMIT_MS = 120_000;

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Playwright baseURL is required to warm routes.");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const route of WARM_ROUTES) {
      let lastNavigation = Date.now();
      const onNavigated = (frame: { parentFrame(): unknown }) => {
        if (frame.parentFrame() === null) lastNavigation = Date.now();
      };
      page.on("framenavigated", onNavigated);
      try {
        await page.goto(new URL(route, baseURL).href, { waitUntil: "load", timeout: ROUTE_LIMIT_MS });
        const deadline = Date.now() + ROUTE_LIMIT_MS;
        while (Date.now() - lastNavigation < QUIET_MS && Date.now() < deadline) {
          await page.waitForTimeout(250);
        }
      } finally {
        page.off("framenavigated", onNavigated);
      }
    }
  } finally {
    await browser.close();
  }
}
