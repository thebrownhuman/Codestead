import type { Page } from "@playwright/test";

const QUIET_MS = 1_500;
const LIMIT_MS = 30_000;

// The e2e server is `next dev`, which compiles a route on first visit and then
// reloads the page it just served. Interacting before those reloads finish loses
// the interaction (a drawer closes, an axe scan's context is destroyed), so wait
// until the main frame has stopped navigating.
export async function gotoSettled(page: Page, url: string) {
  let lastNavigation = Date.now();
  const onNavigated = (frame: { parentFrame(): unknown }) => {
    if (frame.parentFrame() === null) lastNavigation = Date.now();
  };
  page.on("framenavigated", onNavigated);
  try {
    await page.goto(url, { waitUntil: "load" });
    const deadline = Date.now() + LIMIT_MS;
    while (Date.now() - lastNavigation < QUIET_MS && Date.now() < deadline) {
      await page.waitForTimeout(250);
    }
    await page.waitForLoadState("load");
  } finally {
    page.off("framenavigated", onNavigated);
  }
}
