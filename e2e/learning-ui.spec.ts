import { expect, test } from "@playwright/test";

test.describe("authored learning UI", () => {
  test("standalone Code Lab exposes all runner languages without overflowing", async ({ page }) => {
    await page.goto("/playground");
    const selector = page.getByRole("combobox", { name: "Runner language" });
    await expect(selector).toBeVisible();
    await expect(selector.locator("option")).toHaveCount(5);
    expect(await selector.locator("option").allTextContents()).toEqual(["C", "C++", "Java", "JavaScript", "Python"]);
    await selector.selectOption("cpp");
    await expect(selector).toHaveValue("cpp");
    await expect(page.getByText(/C\+\+ practice.*isolated NUC runner/i)).toBeVisible();
    const selectorBox = await selector.boundingBox();
    expect(selectorBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });

  test("learner can request a new subject or an extension without publishing live AI content", async ({ page }) => {
    const saved: Array<Record<string, unknown>> = [];
    await page.route("**/api/learning-requests", async (route) => {
      if (route.request().method() === "POST") {
        const input = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
        saved.push({ id: "10000000-0000-4000-8000-000000000001", ...input, status: "pending", decisionReason: null, createdAt: new Date().toISOString(), decidedAt: null });
        await route.fulfill({ contentType: "application/json", status: 201, body: JSON.stringify({ request: saved[0] }) });
        return;
      }
      await route.fulfill({ contentType: "application/json", status: 200, body: JSON.stringify({ requests: saved }) });
    });
    await page.goto("/requests");
    const panels = page.locator('form[aria-labelledby="new-learning-request-title"], article[aria-labelledby="learning-request-history-title"]');
    await expect(panels).toHaveCount(2);
    const panelBoxes = await panels.evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }));
    const [formBox, historyBox] = panelBoxes;
    const panelsOverlap = Boolean(formBox && historyBox
      && Math.max(formBox.left, historyBox.left) < Math.min(formBox.right, historyBox.right)
      && Math.max(formBox.top, historyBox.top) < Math.min(formBox.bottom, historyBox.bottom));
    expect(panelsOverlap).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.getByLabel("Request type").selectOption("new-subject");
    await page.getByLabel("Subject or topic").fill("High-performance computing");
    await page.getByLabel("What should the course cover?").fill("Parallel fundamentals, profiling, and a small evidence-based project.");
    await page.getByRole("button", { name: "Send for review" }).click();
    await expect(page.getByText("Request sent to the administrator for curriculum review.")).toBeVisible();
    await expect(page.getByText("High-performance computing")).toBeVisible();
    expect(saved[0]).toMatchObject({
      kind: "new-subject",
      subject: "High-performance computing",
      status: "pending",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
  });

  test("administrator triages a curriculum request without treating approval as publication", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "admin operations table is covered at desktop/tablet width");
    const requests: Array<{
      id: string;
      learnerName: string;
      learnerEmail: string;
      kind: string;
      subject: string;
      details: string;
      status: string;
      decisionReason: string | null;
      createdAt: string;
      decidedAt: string | null;
    }> = [{
      id: "request-1",
      learnerName: "Test Learner",
      learnerEmail: "learner@example.test",
      kind: "new-subject",
      subject: "High-performance computing",
      details: "Parallel fundamentals and profiling.",
      status: "pending",
      decisionReason: null,
      createdAt: new Date().toISOString(),
      decidedAt: null,
    }];
    let decision: Record<string, unknown> | undefined;
    await page.route("**/api/admin/learning-requests**", async (route) => {
      if (route.request().method() === "POST") {
        decision = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
        requests[0] = { ...requests[0], status: String(decision.decision), decisionReason: String(decision.reason), decidedAt: new Date().toISOString() };
        await route.fulfill({ contentType: "application/json", status: 200, body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fulfill({ contentType: "application/json", status: 200, body: JSON.stringify({ requests }) });
    });
    await page.goto("/admin/requests");
    await expect(page.getByText(/approval accepts the request into sourcing/i)).toBeVisible();
    await page.getByLabel("Decision reason").fill("Fits the approved extension roadmap.");
    await page.getByRole("button", { name: "Accept for planning" }).click();
    await expect(page.getByText("approved", { exact: true })).toBeVisible();
    expect(decision).toEqual({ decision: "approved", reason: "Fits the approved extension roadmap." });
  });

  test("course roadmap opens a source-linked lesson and state visualizer", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "dense lesson workspace is covered on desktop/tablet viewports");
    await page.goto("/courses/python");

    await expect(page.getByRole("heading", { name: "Python" })).toBeVisible();
    await expect(page.getByText("Declared coverage")).toBeVisible();
    const firstModule = page.locator("details").first();
    await expect(firstModule).toHaveAttribute("open", "");
    const lessonLink = firstModule.getByRole("link").first();
    await lessonLink.click();
    await page.waitForURL(/\/courses\/python\/skills\//);

    await expect(page.getByRole("tab", { name: "Lesson" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Sources and review status" })).toContainText("py-tutorial");
    await page.getByRole("tab", { name: "Visualize" }).click();
    await expect(page.getByText("Step 1: Observe")).toBeVisible();
    await page.getByRole("button", { name: "Next visualizer step" }).click();
    await expect(page.getByText("Step 2: Apply")).toBeVisible();
  });

  test("lesson quest keeps hints distinct from deterministic correctness", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "dense lesson workspace is covered on desktop/tablet viewports");
    let submitted: Record<string, unknown> | undefined;
    await page.route("**/api/games/check", async (route) => {
      submitted = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          correct: true,
          feedback: "The server-side deterministic answer check passed.",
          hint: null,
          stageAdvance: false,
          authoritativeEvidence: false,
          notice: "Practice only; no mastery evidence was awarded.",
        }),
      });
    });
    await page.goto("/courses/python");
    await page.locator("details").first().getByRole("link").first().click();
    await page.waitForURL(/\/courses\/python\/skills\//);
    await page.getByRole("tab", { name: "Quest" }).click();
    await page.getByRole("button", { name: "Use a hint" }).click();
    await expect(page.getByText(/compare each option with both the language-specific boundary case/i)).toBeVisible();
    await page.getByRole("radio", { name: /Use the REPL for a bounded observation/i }).check();
    await page.getByRole("button", { name: "Run action" }).click();
    await expect(page.getByText("The server-side deterministic answer check passed.")).toBeVisible();
    await expect(page.getByText("Practice only; no mastery evidence was awarded.")).toBeVisible();
    expect(submitted).toMatchObject({
      skillId: "python.toolchain.repl",
      response: { selectedOptionIds: ["source-aligned"] },
      hintIndex: 1,
    });
  });

  test("a 768px tablet can operate a formal programming exam", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "tablet-safari", "exact iPad Mini boundary check");

    const sessionId = "10000000-0000-4000-8000-000000000768";
    const now = new Date();
    const timestamp = now.toISOString();
    const exam = {
      sessionId,
      attemptId: "20000000-0000-4000-8000-000000000768",
      attemptNumber: 1,
      status: "active",
      serverNow: timestamp,
      serverStartedAt: timestamp,
      serverDeadlineAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      disconnectedSeconds: 0,
      integrityReviewState: "clear",
      form: {
        schemaVersion: 1,
        formId: "tablet-form",
        courseId: "python",
        courseTitle: "Python",
        moduleId: "python-loops",
        moduleTitle: "Loops",
        contentVersion: "reviewed-v1",
        policyVersion: "formal-exam-v1",
        durationMinutes: 10,
        generatedAt: timestamp,
        instructions: [],
        integrityDisclosure: {
          version: "1",
          summary: "Activity is recorded.",
          capturedEvents: [],
          notCaptured: [],
        },
        items: [
          {
            id: "written-1",
            skillId: "python.loops.trace",
            clusterId: "loops",
            title: "Explain the trace",
            prompt: "Explain why the loop stops.",
            kind: "short-answer",
            points: 4,
            critical: true,
            verificationAvailable: true,
          },
          {
            id: "code-1",
            skillId: "python.loops.code",
            clusterId: "loops",
            title: "Code challenge",
            prompt: "Print a tablet result.",
            kind: "code",
            points: 6,
            critical: true,
            language: "python",
            starterCode: "",
            verificationAvailable: false,
          },
        ],
      },
      answers: {},
      result: null,
      retake: null,
      appealSubmitted: false,
      appeal: null,
    };
    await page.route(`**/api/exams/${sessionId}`, async (route) => {
      await route.fulfill({ contentType: "application/json", status: 200, body: JSON.stringify({ exam }) });
    });
    await page.route(`**/api/exams/${sessionId}/events`, async (route) => {
      await route.fulfill({ contentType: "application/json", status: 200, body: JSON.stringify({ accepted: true }) });
    });
    await page.route(`**/api/exams/${sessionId}/autosave`, async (route) => {
      const request = route.request().postDataJSON() as {
        answer: unknown;
        baseRevision: number;
        clientMutationId: string;
      };
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          saved: {
            answer: request.answer,
            clientMutationId: request.clientMutationId,
            replayed: false,
            revision: request.baseRevision + 1,
            savedAt: new Date().toISOString(),
          },
        }),
      });
    });
    await page.route(`**/api/exams/${sessionId}/run`, async (route) => {
      const finishedAt = new Date().toISOString();
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          result: {
            status: "ACCEPTED",
            requestHash: "a".repeat(64),
            sourceHash: "b".repeat(64),
            runtimeVersion: "python-3.14",
            imageDigest: `sha256:${"c".repeat(64)}`,
            compile: { status: "OK", exitCode: 0, stdout: "", stderr: "", wallTimeMs: 5 },
            run: { exitCode: 0, stdout: "tablet-ok\n", stderr: "", wallTimeMs: 7 },
            tests: [],
            totals: { passed: 0, failed: 0, total: 0 },
            startedAt: finishedAt,
            finishedAt,
          },
        }),
      });
    });

    await page.setViewportSize({ width: 767, height: 1024 });
    await page.goto(`/exams/${sessionId}`);
    const workspace = page.locator("[class*='examWorkspace']");
    await expect(page.getByRole("heading", { name: "Explain the trace" })).toBeVisible();
    await expect.poll(() => workspace.evaluate((element) => getComputedStyle(element, "::after").content))
      .toContain("desktop or tablet-sized screen");

    await page.setViewportSize({ width: 768, height: 1024 });
    await expect.poll(() => workspace.evaluate((element) => getComputedStyle(element, "::after").content))
      .toBe("none");
    await page.getByLabel("Your response").fill("The boundary condition stops the loop.");
    await page.getByRole("button", { name: "Save & next" }).click();
    await expect(page.getByRole("heading", { name: "Code challenge" })).toBeVisible();
    await page.getByLabel("Source code").fill('print("tablet-ok")');
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.locator("pre")).toContainText("tablet-ok");
    expect(page.viewportSize()).toEqual({ width: 768, height: 1024 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });
});
