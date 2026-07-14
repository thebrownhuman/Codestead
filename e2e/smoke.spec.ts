import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.describe("public and learner smoke journeys", () => {
  test("landing page exposes the private-beta entry points", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: /learn to code with a mentor/i })
    ).toBeVisible();
    await expect(page.getByRole("banner").getByRole("link", { name: /request access/i })).toBeVisible();
    await expect(page.getByText("Your own AI keys", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /try the next step/i })).toHaveAttribute("href", "/learn");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("learner can navigate the launch curriculum and exams", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "formal programming exams intentionally require desktop or tablet");
    await page.route("**/api/exams", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({ exams: [] }),
      });
    });
    await page.goto("/courses");

    await expect(
      page.getByRole("heading", { name: "Choose what you want to understand." })
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Course catalog" })).toBeVisible();

    const menuButton = page.getByRole("button", { name: "Open navigation" });
    if (await menuButton.isVisible()) {
      await menuButton.click();
    }
    const examsLink = page.getByRole("link", { name: "Exams" });
    await expect(examsLink).toBeVisible();
    await examsLink.click();
    await expect(page).toHaveURL(/\/exams$/);
    await expect(page.getByRole("heading", { name: "Formal module exams" })).toBeVisible();
  });

  test("mobile view keeps learning navigation usable", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.includes("mobile"), "mobile-only check");
    await page.goto("/learn");

    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Courses" }).last()).toBeVisible();
  });
});
