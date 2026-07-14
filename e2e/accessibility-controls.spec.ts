import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

type Target = {
  name: string;
  path: string;
  viewport: { width: number; height: number };
};

const targets: Target[] = [
  { name: "login on mobile", path: "/login", viewport: { width: 375, height: 812 } },
  { name: "admin curriculum on landscape tablet", path: "/admin/curriculum", viewport: { width: 1024, height: 768 } },
  { name: "exam catalog on tablet", path: "/exams", viewport: { width: 768, height: 1024 } },
  { name: "settings on mobile", path: "/settings", viewport: { width: 375, height: 812 } },
  { name: "tutor workspace on tablet", path: "/tutor", viewport: { width: 768, height: 1024 } },
  { name: "roadmap on mobile", path: "/roadmap", viewport: { width: 375, height: 812 } },
  { name: "roadmap on tablet", path: "/roadmap", viewport: { width: 768, height: 1024 } },
];

async function interactiveTargetFailures(page: Page) {
  return page.evaluate(() => {
    const rendered = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const controls = Array.from(document.querySelectorAll<HTMLElement>(
      "a[href], button, input, select, textarea, summary, [role='button'], [role='link'], [tabindex]:not([tabindex='-1'])",
    )).filter(rendered);

    return controls.flatMap((element) => {
      if (element.matches(":disabled, [aria-disabled='true']")) return [];
      // Focus guards are keyboard-only sentinels that immediately redirect
      // focus inside the navigation trap. They are deliberately screen-reader
      // sized and are not pointer/touch targets.
      if (element.matches("[data-focus-guard]")) return [];
      if (element.tagName === "A" && getComputedStyle(element).display === "inline" && element.closest("p, li")) return [];

      const box = element.getBoundingClientRect();
      if (box.width >= 44 && box.height >= 44) return [];

      if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) {
        const label = element.labels?.[0];
        const labelBox = label?.getBoundingClientRect();
        if (labelBox && labelBox.width >= 44 && labelBox.height >= 44) return [];
      }

      return [{
        tag: element.tagName.toLowerCase(),
        text: (element.getAttribute("aria-label") || element.textContent || element.getAttribute("name") || "").trim().slice(0, 70),
        width: Number(box.width.toFixed(1)),
        height: Number(box.height.toFixed(1)),
        className: typeof element.className === "string" ? element.className : "",
      }];
    });
  });
}

async function expectFontSizeAtLeast(page: Page, selector: string, minimumPx: number) {
  const element = page.locator(selector).first();
  await expect(element).toBeVisible();
  const size = await element.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  expect(size).toBeGreaterThanOrEqual(minimumPx);
}

async function expectRoadmapBadgeContrast(page: Page) {
  const ratios = await page.locator('[class*="trackIcon"]').evaluateAll((elements) => {
    const luminance = (value: string) => {
      const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
      const linear = channels.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
    };
    return elements.map((element) => {
      const style = getComputedStyle(element);
      const foreground = luminance(style.color);
      const background = luminance(style.backgroundColor);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
  });
  expect(ratios.length).toBeGreaterThanOrEqual(5);
  expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
}

test.describe("critical control accessibility", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "focused geometry and Axe coverage runs once in Chromium");
  });

  for (const target of targets) {
    test(`${target.name} keeps controls reachable and WCAG A/AA clean`, async ({ page }) => {
      await page.setViewportSize(target.viewport);
      if (target.path === "/settings") {
        await page.route("**/api/credentials", (route) => route.fulfill({
          contentType: "application/json",
          status: 200,
          body: JSON.stringify({ credentials: [{
            id: "10000000-0000-4000-8000-000000000001",
            provider: "nvidia_nim",
            label: "NVIDIA NIM",
            lastFour: "ABCD",
            status: "active",
            isPreferred: true,
            routingConsented: true,
            lastValidatedAt: null,
          }] }),
        }));
      }
      if (target.path === "/tutor") {
        await page.route("**/api/ai/threads?**", (route) => route.fulfill({
          contentType: "application/json",
          status: 200,
          body: JSON.stringify({ threads: [{
            id: "20000000-0000-4000-8000-000000000001",
            title: "Python values",
            status: "active",
            messageCount: 2,
            provider: "nvidia_nim",
            model: "tutor-model",
            credentialSource: "learner",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }], nextCursor: null }),
        }));
      }
      if (target.path === "/exams") {
        await page.route("**/api/exams", (route) => route.fulfill({
          contentType: "application/json",
          status: 200,
          body: JSON.stringify({ exams: [{
            courseId: "python",
            courseTitle: "Python",
            moduleId: "python.loops",
            moduleTitle: "Loops",
            summary: "Demonstrate independent loop reasoning and implementation.",
            skillCount: 4,
            durationMinutes: 24,
            readiness: "available",
            activeSessionId: null,
            latestResult: null,
            retake: { eligible: true, reason: "first-attempt", nextEligibleAt: null, requiresRemediation: false },
            masteryRecheck: null,
          }] }),
        }));
      }
      await page.goto(target.path, { waitUntil: "networkidle" });
      await expect(page.locator("body")).toBeVisible();

      if (target.path === "/exams") {
        await page.getByRole("button", { name: /Review and start/i }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
      }

      const failures = await interactiveTargetFailures(page);
      expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);

      if (target.path === "/admin/curriculum") {
        await expectFontSizeAtLeast(page, '[class*="adminIdentity"] small', 12);
        await expectFontSizeAtLeast(page, '[class*="adminPage"] [class*="pageHead"] p', 14);
      }
      if (target.path === "/tutor") {
        await expectFontSizeAtLeast(page, '[class*="assistantBubble"]', 14);
        await expectFontSizeAtLeast(page, '[class*="messageProvenance"]', 12);
      }
      if (target.path === "/roadmap") await expectRoadmapBadgeContrast(page);

      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);
    });
  }
});
