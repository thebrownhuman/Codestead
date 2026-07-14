import { expect, test } from "@playwright/test";

test.describe("fail-closed learning and credential controls", () => {
  test("an unreviewed authored lesson carries provenance without claiming mastery", async ({ page }) => {
    await page.goto("/courses/git-tooling/skills/git.branches.merge");

    await expect(page.getByTestId("authored-lesson")).toBeVisible();
    await expect(page.getByText(/draft preview.*AI-assisted draft/i)).toBeVisible();
    await expect(page.getByText(/no human editorial review yet/i)).toBeVisible();
    await expect(page.getByText(/provenance, not a mastery or accuracy claim/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /award mastery|mark mastered/i })).toHaveCount(0);
  });

  test("a pending-review exam never invents a score or opens a retake", async ({ page }) => {
    const finalizedAt = new Date("2026-07-12T05:00:00.000Z").toISOString();
    await page.route("**/api/exams", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          exams: [{
            courseId: "python",
            courseTitle: "Python",
            moduleId: "python-state",
            moduleTitle: "Variables and state",
            summary: "A bounded module exam with one item awaiting authored evidence.",
            skillCount: 4,
            durationMinutes: 30,
            readiness: "pending-review",
            activeSessionId: null,
            latestResult: {
              schemaVersion: 1,
              gradingStatus: "pending-review",
              outcome: "PENDING_REVIEW",
              officialScorePercent: null,
              earnedPoints: null,
              possiblePoints: 20,
              pendingReviewItemIds: ["item-without-oracle"],
              failedCriticalClusters: [],
              masteryBlockingCodingItems: [],
              compilationGatePassed: null,
              infrastructureFailure: false,
              finalizedAt,
              finalizedBy: "learner-submit",
              policyVersion: "formal-exam-v1",
              remediation: { required: false, targets: [] },
            },
            retake: {
              eligible: false,
              reason: "pending-review",
              nextEligibleAt: null,
              requiresRemediation: false,
            },
          }],
        }),
      });
    });

    await page.goto("/exams");
    const card = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: "Variables and state" }),
    });
    await expect(card.getByText("Pending review", { exact: true })).toBeVisible();
    await expect(card.getByText(/new form opens after the current submission is reviewed/i)).toBeVisible();
    await expect(card.getByText(/\d+%/)).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Start eligible retake" })).toBeDisabled();
    await expect(page.getByText(/no oracle means pending review, not a guessed score/i)).toBeVisible();
  });

  test("provider changes require a fresh authenticator check before mutation", async ({ page }) => {
    let freshMfaCalls = 0;
    let mutationCalls = 0;

    await page.route("**/api/credentials", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          credentials: [{
            id: "credential-1",
            provider: "nvidia_nim",
            label: "Personal NIM",
            lastFour: "9xyz",
            status: "active",
            isPreferred: true,
            routingConsented: true,
            lastValidatedAt: null,
          }],
        }),
      });
    });
    await page.route("**/api/security/fresh-mfa", async (route) => {
      freshMfaCalls += 1;
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({ validUntil: "2026-07-12T05:05:00.000Z" }),
      });
    });
    await page.route("**/api/credentials/credential-1", async (route) => {
      mutationCalls += 1;
      expect(route.request().method()).toBe("PATCH");
      expect(JSON.parse(route.request().postData() ?? "{}")).toEqual({ action: "test" });
      await route.fulfill({ contentType: "application/json", status: 200, body: JSON.stringify({ ok: true }) });
    });

    await page.goto("/settings?section=ai");
    await expect(page.getByText("Personal NIM")).toBeVisible();
    await page.getByRole("button", { name: "Test", exact: true }).click();
    await expect(page.locator("p[role='alert']")).toContainText("six-digit authenticator code");
    expect(freshMfaCalls).toBe(0);
    expect(mutationCalls).toBe(0);

    await page.getByLabel("Authenticator code for provider changes").fill("123456");
    await page.getByRole("button", { name: "Verify authenticator" }).click();
    await expect(page.getByRole("button", { name: "Verified" })).toBeDisabled();
    expect(freshMfaCalls).toBe(1);

    await page.getByRole("button", { name: "Test", exact: true }).click();
    await expect.poll(() => mutationCalls).toBe(1);
  });
});
