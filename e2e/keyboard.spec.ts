import { expect, test } from "@playwright/test";

test("skip link moves keyboard focus to the main content", async ({ page }) => {
  await page.goto("/courses");
  await expect(page.getByRole("heading", { name: "Choose what you want to understand." })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
});

test("auth pages expose the global skip-link target", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Continue your learning" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
});

test("mobile navigation exposes state and closes with Escape", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "mobile navigation check");
  await page.goto("/courses");
  const trigger = page.getByRole("button", { name: "Open navigation" });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("complementary")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});
