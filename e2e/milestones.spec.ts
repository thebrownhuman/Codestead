import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const certificate = {
  id: "a3000000-0000-4000-8000-000000000001",
  verificationId: "public-verifier-token",
  learnerDisplayName: "Aarav Rao",
  learnerEmail: "aarav@example.test",
  courseTitle: "Python foundations",
  courseVersion: "1.0.0",
  policyVersion: "certificate-v1",
  issuedAt: "2026-07-14T00:00:00.000Z",
  status: "valid",
  revokedAt: null,
  revocationReason: null,
  verificationPath: "/verify/public-verifier-token",
};

async function mockMilestoneApis(page: Page) {
  await page.route("**/api/certificates", async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      certificates: [certificate],
      candidates: [{
        enrollmentId: "a1000000-0000-4000-8000-000000000001",
        courseTitle: "Python foundations",
        courseVersion: "1.0.0",
        enrollmentStatus: "completed",
        masteredConcepts: 12,
        totalConcepts: 12,
        eligible: true,
        alreadyIssued: true,
        reason: "Current verified version and valid mastery evidence.",
      }],
    }),
  }));
  await page.route("**/api/portfolio", async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ settings: {
      profile: { slug: "aarav-builds", displayName: "Aarav Rao", headline: "Building verified Python projects", about: "Learning in public.", isPublished: false, rowVersion: 1 },
      projects: [{ id: "project-1", title: "Study planner", summary: "A bounded public summary.", status: "reviewed", githubUrl: "https://github.com/aarav/study-planner", selected: true }],
      achievements: [{ id: "award-1", title: "Python complete", description: "Verified completion.", icon: "award", selected: true }],
      certificates: [{ id: certificate.id, title: certificate.courseTitle, version: certificate.courseVersion, selected: true }],
      disclosure: "Publishing exposes only your selected display content and proof. Email, scores, attempts, code, chat, and provider data are excluded.",
    } }),
  }));
  await page.route("**/api/admin/certificates", async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ certificates: [certificate] }),
  }));
}

test.beforeEach(async ({ page }) => {
  await mockMilestoneApis(page);
});

for (const [name, path, heading] of [
  ["career", "/career", "Career trails, without the crystal ball."],
  ["certificates", "/certificates", "Proof you earned, not a participation PDF."],
  ["portfolio", "/portfolio", "Share the proof you choose. Nothing else."],
  ["admin certificates", "/admin/certificates", "Revoke the proof, preserve the reason."],
] as const) {
  test(`${name} milestone view has no automated WCAG A/AA violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test("milestone views remain usable at 320 CSS pixels without horizontal document overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  for (const [path, heading] of [
    ["/career", "Career trails, without the crystal ball."],
    ["/certificates", "Proof you earned, not a participation PDF."],
    ["/portfolio", "Share the proof you choose. Nothing else."],
    ["/admin/certificates", "Revoke the proof, preserve the reason."],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
});

test("certificate revocation controls are keyboard reachable and explain permanence", async ({ page }) => {
  await page.goto("/admin/certificates");
  const review = page.getByRole("button", { name: "Review revocation" });
  await review.focus();
  await page.keyboard.press("Enter");
  const reason = page.getByLabel("Private administrative reason");
  await expect(reason).toBeFocused();
  await reason.fill("Verified integrity correction");
  await expect(page.getByRole("button", { name: "Confirm permanent revocation" })).toBeEnabled();
  await expect(page.getByText(/action cannot be undone/i)).toBeVisible();
});

test("career milestone visual smoke supports dark and reduced-motion preferences", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/career");
  await expect(page.getByRole("heading", { name: "Career trails, without the crystal ball." })).toBeVisible();
  await page.screenshot({ path: "test-artifacts/milestones-career-dark-reduced.png", fullPage: true });
});
