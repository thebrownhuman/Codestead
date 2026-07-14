import { expect, test, type Page } from "@playwright/test";

async function expectNoDocumentOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  )).toBe(true);
}

async function applyTextSize(page: Page, size: "150" | "200") {
  await page.evaluate((preference) => {
    document.documentElement.dataset.textSize = preference;
    document.documentElement.style.setProperty("--user-root-font-size", `${preference}%`);
  }, size);
  await page.waitForTimeout(100);
}

async function applyLargeText(page: Page) {
  await applyTextSize(page, "200");
}

test.describe("responsive UI regressions", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "focused viewport coverage runs once in Chromium");
  });

  test("administrator navigation stays inside a 1024px landscape viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/admin/curriculum");

    const navigation = page.getByRole("navigation", { name: "Administrator sections" });
    await expect(navigation).toBeVisible();
    const geometry = await navigation.evaluate((element) => {
      const rail = element.parentElement;
      const identity = rail?.firstElementChild;
      if (!rail || !identity) throw new Error("Administrator rail structure is missing.");
      const railBox = rail.getBoundingClientRect();
      const identityBox = identity.getBoundingClientRect();
      const navigationBox = element.getBoundingClientRect();
      return {
        railLeft: railBox.left,
        railRight: railBox.right,
        identityBottom: identityBox.bottom,
        navigationTop: navigationBox.top,
      };
    });

    expect(geometry.railLeft).toBeGreaterThanOrEqual(0);
    expect(geometry.railRight).toBeLessThanOrEqual(1025);
    expect(geometry.navigationTop).toBeGreaterThanOrEqual(geometry.identityBottom - 1);
    await expectNoDocumentOverflow(page);
  });

  test("Code Lab remains usable at 375px with 200 percent text", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/playground");
    await applyLargeText(page);

    await expect(page.getByRole("heading", { name: "Code lab." })).toBeVisible();
    const language = page.getByRole("combobox", { name: "Runner language" });
    await expect(language).toBeVisible();
    const codeLab = language.locator("xpath=ancestor::div[2]");
    const codeLabBox = await codeLab.boundingBox();
    expect(codeLabBox).not.toBeNull();
    expect(codeLabBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(codeLabBox ? codeLabBox.x + codeLabBox.width : 376).toBeLessThanOrEqual(376);
    await expectNoDocumentOverflow(page);
  });

  test("review empty state and fixed navigation fit at 375px with 200 percent text", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/review");
    await applyLargeText(page);

    await expect(page.getByRole("heading", { name: "Review what is almost slipping." })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Review preview data" })).toBeVisible();
    const reviewRow = page.getByText("No review is due.", { exact: true }).locator("xpath=ancestor::article[1]");
    const returnHomeLink = page.getByRole("link", { name: /Nothing due.*return home/i });
    await expect(reviewRow).toBeVisible();
    await expect(returnHomeLink).toBeVisible();
    await expect(returnHomeLink).toHaveAttribute("href", "/learn");
    const rowBox = await reviewRow.boundingBox();
    const linkBox = await returnHomeLink.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(linkBox).not.toBeNull();
    expect(rowBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(rowBox ? rowBox.x + rowBox.width : 376).toBeLessThanOrEqual(376);
    expect(linkBox?.width ?? 0).toBeGreaterThan(0);

    const clearance = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>("#main-content");
      const navigation = document.querySelector<HTMLElement>('nav[aria-label="Mobile navigation"]');
      if (!main || !navigation) throw new Error("Mobile shell structure is missing.");
      const navigationBox = navigation.getBoundingClientRect();
      return {
        paddingBottom: Number.parseFloat(getComputedStyle(main).paddingBottom),
        requiredClearance: navigationBox.height + (window.innerHeight - navigationBox.bottom),
      };
    });
    expect(clearance.paddingBottom).toBeGreaterThanOrEqual(clearance.requiredClearance);
    await expectNoDocumentOverflow(page);
  });

  test("learner shell keeps large-text chrome separated at 320px and 375px", async ({ page }) => {
    for (const width of [320, 375]) {
      for (const size of ["150", "200"] as const) {
        await page.setViewportSize({ width, height: width === 320 ? 568 : 812 });
        await page.goto("/learn");
        await applyTextSize(page, size);

        const geometry = await page.evaluate(() => {
          const header = document.querySelector<HTMLElement>("#app-content-column > header");
          const main = document.querySelector<HTMLElement>("#main-content");
          const navigation = document.querySelector<HTMLElement>('nav[aria-label="Mobile navigation"]');
          if (!header || !main || !navigation) throw new Error("Mobile shell structure is missing.");
          const headerBox = header.getBoundingClientRect();
          const mainBox = main.getBoundingClientRect();
          const navigationBox = navigation.getBoundingClientRect();
          return {
            headerBottom: headerBox.bottom,
            mainTop: mainBox.top,
            navigationLeft: navigationBox.left,
            navigationRight: navigationBox.right,
            navigationHeight: navigationBox.height,
            navigationBottomGap: window.innerHeight - navigationBox.bottom,
            mainPaddingBottom: Number.parseFloat(getComputedStyle(main).paddingBottom),
          };
        });

        expect(geometry.mainTop).toBeGreaterThanOrEqual(geometry.headerBottom - 1);
        expect(geometry.navigationLeft).toBeGreaterThanOrEqual(0);
        expect(geometry.navigationRight).toBeLessThanOrEqual(width + 1);
        expect(geometry.navigationHeight).toBeGreaterThan(0);
        expect(geometry.mainPaddingBottom).toBeGreaterThanOrEqual(
          geometry.navigationHeight + geometry.navigationBottomGap,
        );
        await expectNoDocumentOverflow(page);
      }
    }
  });

  test("route-stage motion disappears for system and in-app reduced-motion preferences", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/learn");

    const routeStage = page.locator("[data-route-stage]");
    await page.evaluate(() => { document.documentElement.dataset.motion = "system"; });
    await expect.poll(() => routeStage.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");

    await page.evaluate(() => { document.documentElement.dataset.motion = "reduce"; });
    await expect.poll(() => routeStage.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  });
});
