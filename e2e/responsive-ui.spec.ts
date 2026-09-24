import { expect, test, type Page } from "@playwright/test";

async function expectNoDocumentOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  )).toBe(true);
}

async function expectFloatingMenuShell(page: Page, width: number) {
  await expect(page.locator('nav[aria-label="Mobile navigation"]')).toHaveCount(0);
  await expect(page.locator("#app-content-column > header")).toHaveCount(0);
  const menuButton = page.getByRole("button", { name: "Open navigation" });
  await expect(menuButton).toBeVisible();
  const heading = page.locator("#main-content").getByRole("heading").first();
  await expect(heading).toBeVisible();

  const menuBox = await menuButton.boundingBox();
  const headingBox = await heading.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(headingBox).not.toBeNull();
  if (!menuBox || !headingBox) return;
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width + 1);
  const overlaps =
    menuBox.x < headingBox.x + headingBox.width &&
    headingBox.x < menuBox.x + menuBox.width &&
    menuBox.y < headingBox.y + headingBox.height &&
    headingBox.y < menuBox.y + menuBox.height;
  expect(overlaps, `menu ${JSON.stringify(menuBox)} overlaps heading ${JSON.stringify(headingBox)}`).toBe(false);
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

  test("mentor cockpit keeps its composer reachable in a short phone viewport", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 480 });
    await page.goto("/courses/python/skills/python.toolchain.repl");
    await page.getByRole("button", { name: /Ask Codestead/i }).click();

    const dialog = page.getByRole("dialog", { name: "Codestead mentor" });
    const composer = page.getByRole("textbox", { name: "Message Codestead" });
    await expect(dialog).toBeVisible();
    await expect(composer).toBeVisible();
    const geometry = await dialog.evaluate((element) => {
      const input = element.querySelector("textarea");
      if (!input) throw new Error("Mentor composer is missing.");
      const dialogBox = element.getBoundingClientRect();
      const inputBox = input.getBoundingClientRect();
      return {
        dialogBottom: dialogBox.bottom,
        dialogTop: dialogBox.top,
        inputBottom: inputBox.bottom,
        inputTop: inputBox.top,
      };
    });

    expect(geometry.dialogTop).toBeGreaterThanOrEqual(0);
    expect(geometry.dialogBottom).toBeLessThanOrEqual(481);
    expect(geometry.inputTop).toBeGreaterThanOrEqual(geometry.dialogTop);
    expect(geometry.inputBottom).toBeLessThanOrEqual(geometry.dialogBottom);
    await expectNoDocumentOverflow(page);
  });

  test("mentor cockpit keeps its close control and composer visible in phone landscape", async ({ page }) => {
    await page.setViewportSize({ width: 667, height: 375 });
    await page.goto("/courses/python/skills/python.toolchain.repl");
    await page.getByRole("button", { name: /Ask Codestead/i }).click();
    await page.waitForTimeout(500);

    const dialog = page.getByRole("dialog", { name: "Codestead mentor" });
    const geometry = await dialog.evaluate((element) => {
      const close = element.querySelector<HTMLButtonElement>('button[aria-label="Close tutor"]');
      const input = element.querySelector("textarea");
      if (!close || !input) throw new Error("Mentor cockpit controls are missing.");
      const dialogBox = element.getBoundingClientRect();
      const closeBox = close.getBoundingClientRect();
      const inputBox = input.getBoundingClientRect();
      return {
        closeBottom: closeBox.bottom,
        closeTop: closeBox.top,
        dialogBottom: dialogBox.bottom,
        dialogTop: dialogBox.top,
        inputBottom: inputBox.bottom,
        inputTop: inputBox.top,
      };
    });

    expect(geometry.closeTop).toBeGreaterThanOrEqual(geometry.dialogTop);
    expect(geometry.closeBottom).toBeLessThanOrEqual(geometry.dialogBottom);
    expect(geometry.inputTop).toBeGreaterThanOrEqual(geometry.dialogTop);
    expect(geometry.inputBottom).toBeLessThanOrEqual(geometry.dialogBottom);
    await expectNoDocumentOverflow(page);
  });

  test("mentor composer keeps a visible focus ring in forced colors", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto("/courses/python/skills/python.toolchain.repl");
    await page.getByRole("button", { name: /Ask Codestead/i }).click();
    const composer = page.getByRole("textbox", { name: "Message Codestead" });
    await composer.focus();

    const focusStyle = await composer.evaluate((element) => {
      const wrapper = element.closest("form");
      if (!wrapper) throw new Error("Mentor composer wrapper is missing.");
      const style = getComputedStyle(wrapper);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });

    expect(focusStyle.outlineStyle).not.toBe("none");
    expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(2);
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

    await expectFloatingMenuShell(page, 375);
    await expectNoDocumentOverflow(page);
  });

  test("learner shell keeps large-text chrome separated at 320px and 375px", async ({ page }) => {
    for (const width of [320, 375]) {
      for (const size of ["150", "200"] as const) {
        await page.setViewportSize({ width, height: width === 320 ? 568 : 812 });
        await page.goto("/learn");
        await applyTextSize(page, size);

        await expectFloatingMenuShell(page, width);
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
