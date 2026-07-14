import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const pages = [
  ["sign in", "/login"],
  ["access request", "/request-access"],
  ["course catalog", "/courses"],
  ["learning home", "/learn"],
] as const;

for (const [name, path] of pages) {
  test(`${name} has no automated WCAG A/AA violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator("body")).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test("primary actions retain WCAG contrast in dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withRules(["color-contrast"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("landing lesson preview and call to action retain WCAG contrast in dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /learn to code with a mentor/i })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withRules(["color-contrast"])
    .analyze();
  expect(results.violations).toEqual([]);
});
