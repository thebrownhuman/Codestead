import { readFile } from "node:fs/promises";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const prototype = "http://127.0.0.1:3137/__design-prototype/robot-courier.html";
const contentTypes: Record<string, string> = {
  "robot-courier.html": "text/html",
  "robot-courier.css": "text/css",
  "robot-courier.js": "text/javascript",
};

test.beforeEach(async ({ page }) => {
  // Serve only these three static files through Playwright's HTTP fixture.
  // This works in browsers that disallow file URLs and needs no extra server.
  await page.route("http://127.0.0.1:3137/__design-prototype/*", async (route) => {
    const file = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    if (!Object.hasOwn(contentTypes, file)) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({ contentType: contentTypes[file], body: await readFile(path.resolve("docs/reviews/prototypes", file)) });
  });
  await page.goto(prototype);
});

test("requires a prediction, traces a delivery, and steps backward correctly", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Run program" })).toBeDisabled();
  await page.getByLabel("Predicted column").selectOption("4");
  await page.getByLabel("Predicted row").selectOption("3");
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(page.getByRole("status")).toContainText("Package delivered. Your prediction matched.");
  await page.getByRole("button", { name: "Show result" }).click();
  await expect(page.locator("#position")).toContainText("Courier: column 4, row 3.");
  await expect(page.getByRole("button", { name: "Next step" })).toBeDisabled();
  await page.getByRole("button", { name: "Previous step" }).click();
  await expect(page.locator("#position")).toContainText("Courier: column 3, row 3.");
});

test("repairs an off-by-one loop and invalidates a stale run after editing", async ({ page }) => {
  await page.getByRole("button", { name: "2 · Repair" }).click();
  await page.getByLabel("Predicted column").selectOption("4");
  await page.getByLabel("Predicted row").selectOption("2");
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(page.getByRole("status")).toContainText("Not delivered yet. Your prediction matched.");
  await page.getByLabel("Repeat command 1: move east").fill("4");
  await page.getByLabel("Repeat command 1: move east").press("Tab");
  await expect(page.getByRole("button", { name: "Run program" })).toBeDisabled();
  await expect(page.getByLabel("Generated Python preview")).toContainText("range(4)");
  await page.getByLabel("Predicted column").selectOption("5");
  await page.getByLabel("Predicted row").selectOption("2");
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(page.getByRole("status")).toContainText("Package delivered. Your prediction matched.");
});

test("reports blocked movement, permits a new solution, and bounds command groups", async ({ page }) => {
  await page.getByRole("button", { name: "3 · Build" }).click();
  await page.getByLabel("New direction").selectOption("south");
  await page.getByRole("button", { name: "Add command" }).click();
  await page.getByLabel("Predicted column").selectOption("1");
  await page.getByLabel("Predicted row").selectOption("4");
  await page.getByRole("button", { name: "Run program" }).click();
  await page.getByRole("button", { name: "Show result" }).click();
  await expect(page.locator("#trace")).toContainText("map boundary");
  await page.getByRole("button", { name: "Remove command 1" }).click();
  await page.getByLabel("New direction").selectOption("north");
  await page.getByLabel("New repeat count").fill("3");
  await page.getByRole("button", { name: "Add command" }).click();
  await page.getByLabel("New direction").selectOption("east");
  await page.getByLabel("New repeat count").fill("4");
  await page.getByRole("button", { name: "Add command" }).click();
  await page.getByLabel("Predicted column").selectOption("5");
  await page.getByLabel("Predicted row").selectOption("1");
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(page.getByRole("status")).toContainText("Package delivered. Your prediction matched.");
  for (let index = 0; index < 6; index++) await page.getByRole("button", { name: "Add command" }).click();
  await expect(page.getByRole("button", { name: "Add command" })).toBeDisabled();
  await expect(page.locator(".command")).toHaveCount(8);
});

test("has no automated WCAG A/AA violations or horizontal overflow", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(result.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
});
