import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const learnerId = "b1000000-0000-4000-8000-000000000002";
const credentialId = "a1000000-0000-4000-8000-000000000001";
const reason = "Help the learner repair their provider configuration.";
const revealedPlaintext = "temporary-browser-credential-1234";

function learnerDetail() {
  return {
    generatedAt: new Date().toISOString(),
    learner: {
      publicId: learnerId,
      name: "Credential Learner",
      email: "credential-learner@example.test",
      status: "active",
      emailVerified: true,
      mfaEnabled: true,
      level: "beginner",
      preferredSessionMinutes: 30,
      weeklyGoalMinutes: 180,
      selectedTracks: ["python"],
      learningGoals: [],
      onboardingCompletedAt: new Date().toISOString(),
      lastMeaningfulActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    },
    enrollments: [],
    mastery: {
      total: 0,
      averageScore: 0,
      averageConfidence: 0,
      reviewDue: 0,
      statuses: [],
      recent: [],
    },
    attempts: {
      total: 0,
      passed: 0,
      passRate: 0,
      averageScore: 0,
      statuses: [],
      recent: [],
    },
    sessions: { total: 0, active: 0, plannedMinutes: 0, completedMinutes: 0, recent: [] },
    chats: { threads: 0, messages: 0, recent: [] },
    projects: { total: 0, recent: [] },
    credentials: [{
      id: credentialId,
      ownerPublicId: learnerId,
      ownerName: "Credential Learner",
      provider: "nvidia_nim",
      lastFour: "ABCD",
      status: "active",
      preferred: true,
      lastValidatedAt: null,
      lastUsedAt: null,
      failureCode: null,
    }],
    operations: {
      activeAuthSessions: 1,
      lastSessionSeenAt: new Date().toISOString(),
      storageObjects: 0,
      storageBytes: 0,
      pendingScans: 0,
      quotaBytes: 2 * 1024 ** 3,
      quotaPercent: 0,
      quotaRowVersion: 1,
      emailStatuses: [],
    },
    appeals: [],
  };
}

test.describe("administrator credential ceremony", () => {
  test("reveals ephemerally and performs an owner-bound replacement after fresh MFA", async ({ page }) => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    await page.route(`**/api/admin/dashboard/learners/${learnerId}`, (route) => route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify(learnerDetail()),
    }));
    await page.route("**/api/security/fresh-mfa", async (route) => {
      calls.push({
        url: new URL(route.request().url()).pathname,
        method: route.request().method(),
        body: JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>,
      });
      await route.fulfill({ contentType: "application/json", status: 200, body: JSON.stringify({ ok: true }) });
    });
    await page.route(`**/api/admin/credentials/${credentialId}/reveal`, async (route) => {
      calls.push({
        url: new URL(route.request().url()).pathname,
        method: route.request().method(),
        body: JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>,
      });
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({ credential: revealedPlaintext, provider: "nvidia_nim", lastFour: "ABCD" }),
      });
    });
    await page.route(`**/api/admin/credentials/${credentialId}`, async (route) => {
      calls.push({
        url: new URL(route.request().url()).pathname,
        method: route.request().method(),
        body: JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>,
      });
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({ ok: true, action: "replace", status: "active", auditCorrelationId: "audit-1" }),
      });
    });

    await page.goto(`/admin/learners/${learnerId}`);
    await expect(page.getByRole("heading", { name: "Credential Learner" })).toBeVisible();
    await expect(page.getByText("•••• ABCD")).toBeVisible();
    await expect(page.getByText(revealedPlaintext)).toHaveCount(0);

    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);

    const ceremony = page.getByRole("group", { name: /Fresh-MFA credential ceremony/i });
    await ceremony.getByLabel(/authenticator code/i).fill("123456");
    await ceremony.getByLabel("Recorded reason").fill(reason);
    await ceremony.getByRole("button", { name: /Reveal for 30 seconds/i }).click();
    await expect(page.getByText(revealedPlaintext)).toBeVisible();
    expect(calls.slice(0, 2)).toEqual([
      { url: "/api/security/fresh-mfa", method: "POST", body: { code: "123456" } },
      { url: `/api/admin/credentials/${credentialId}/reveal`, method: "POST", body: { reason } },
    ]);
    await page
      .getByLabel("Temporarily revealed credential")
      .getByRole("button", { name: /Clear now/i })
      .click();
    await expect(page.getByText(revealedPlaintext)).toHaveCount(0);

    const replacement = "replacement-browser-credential-5678";
    await ceremony.getByLabel(/authenticator code/i).fill("654321");
    await ceremony.getByLabel("Recorded reason").fill(reason);
    await ceremony.getByLabel(/replacement credential/i).fill(replacement);
    await ceremony.getByRole("button", { name: /Replace credential/i }).click();
    await expect(page.getByText(/learner was notified/i)).toBeVisible();
    expect(calls.slice(-2)).toEqual([
      { url: "/api/security/fresh-mfa", method: "POST", body: { code: "654321" } },
      {
        url: `/api/admin/credentials/${credentialId}`,
        method: "PATCH",
        body: {
          learnerId,
          reason,
          action: "replace",
          secret: replacement,
          requestId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
        },
      },
    ]);
    expect(await page.evaluate(() => JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }))).not.toContain(replacement);
  });
});
