import { expect, test, type Page } from "@playwright/test";

type RunnerRequest = {
  clientRequestId: string;
  language: string;
  mode: string;
  skillId: string;
  source: string;
  stdin?: string;
};

async function mockDraftEndpoints(page: Page) {
  await page.route("**/api/drafts**", async (route) => {
    if (route.request().method() === "PUT") {
      const input = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      const now = new Date().toISOString();
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          draft: {
            id: "20000000-0000-4000-8000-000000000001",
            kind: input.kind ?? "code",
            courseId: input.courseId ?? "python",
            skillId: input.skillId ?? "free-playground",
            language: input.language ?? "python",
            content: input.content ?? "",
            rowVersion: 1,
            createdAt: now,
            updatedAt: now,
          },
          committedRowVersion: 1,
          replayed: false,
          cacheNamespace: null,
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify({ draft: null, cacheNamespace: null }),
    });
  });
}

async function openCodeLab(page: Page) {
  await mockDraftEndpoints(page);
  await page.goto("/playground");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Code lab." })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Runner language" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
}

test.describe("standalone Code Lab runner UX", () => {
  test("loads the same-origin rich editor without AMD module errors", async ({ page }, testInfo) => {
    test.skip(!["chromium", "webkit"].includes(testInfo.project.name), "desktop Chromium and WebKit loader regression");
    const monacoErrors: string[] = [];
    const monacoRequests: string[] = [];
    page.on("pageerror", (error) => {
      const detail = `${error.message}\n${error.stack ?? ""}`;
      if (/monaco|property description must be an object/i.test(detail)) monacoErrors.push(detail);
    });
    page.on("request", (request) => {
      if (/\/monaco\/vs\//.test(request.url())) monacoRequests.push(request.url());
    });

    await openCodeLab(page);

    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 10_000 });
    expect(monacoErrors).toEqual([]);
    expect(monacoRequests.some((url) => url.endsWith("/monaco/vs/loader.js"))).toBe(true);
    expect(monacoRequests.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
  });

  test("shows successful stdout and a completed live status", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "runner interaction contract is exercised once in Chromium");
    let submitted: RunnerRequest | undefined;
    await page.route("**/api/code/run", async (route) => {
      submitted = JSON.parse(route.request().postData() ?? "{}") as RunnerRequest;
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          requestId: submitted.clientRequestId,
          status: "accepted",
          stdout: "30\n",
          stderr: "",
          officialMasteryEvidence: false,
        }),
      });
    });
    await openCodeLab(page);

    const runButton = page.getByRole("button", { name: "Run", exact: true });
    const outputId = await runButton.getAttribute("aria-controls");
    expect(outputId).toBeTruthy();
    await page.getByLabel(/Program input stdin/i).fill("10\n20");
    await runButton.click();

    await expect(page.getByText("Completed", { exact: true })).toBeVisible();
    await expect(page.locator("pre").filter({ hasText: "30" })).toBeVisible();
    await expect(page.getByRole("status", { name: "Run status" })).toHaveText("Run completed. Standard output is ready.");
    await expect(page.locator(`#${outputId}`)).toHaveAttribute("aria-busy", "false");
    expect(submitted).toMatchObject({
      language: "python",
      mode: "quick_run",
      skillId: "free-playground",
      stdin: "10\n20",
      clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
  });

  test("explains exhausted Python stdin while preserving the real traceback", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "beginner error guidance is exercised once in Chromium");
    await page.route("**/api/code/run", async (route) => {
      const input = JSON.parse(route.request().postData() ?? "{}") as RunnerRequest;
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          requestId: input.clientRequestId,
          status: "runtime_error",
          stdout: "Enter first number: ",
          stderr: "Traceback (most recent call last):\nEOFError: EOF when reading a line\n",
        }),
      });
    });
    await openCodeLab(page);

    await page.getByRole("button", { name: "Run", exact: true }).click();

    await expect(page.getByText("Program input needed", { exact: true })).toBeVisible();
    await expect(page.getByText(/Program input is empty.*one value per line/i)).toBeVisible();
    await expect(page.locator("pre").filter({ hasText: "EOFError: EOF when reading a line" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Ask Codestead about this error" })).toHaveAttribute("href", "/tutor");
    await expect(page.getByText(/code and output are not sent automatically/i)).toBeVisible();
  });

  test("a definite offline result offers Retry and retrying creates a new request", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "runner interaction contract is exercised once in Chromium");
    const requests: RunnerRequest[] = [];
    await page.route("**/api/code/run", async (route) => {
      const input = JSON.parse(route.request().postData() ?? "{}") as RunnerRequest;
      requests.push(input);
      if (requests.length === 1) {
        await route.fulfill({
          contentType: "application/json",
          status: 503,
          body: JSON.stringify({
            requestId: input.clientRequestId,
            status: "offline",
            code: "RUNNER_OFFLINE",
            retryable: true,
            indeterminate: false,
            error: "The isolated runner is offline. No code was dispatched. Start the runner, then retry.",
          }),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({ requestId: input.clientRequestId, status: "accepted", stdout: "retry-success\n" }),
      });
    });
    await openCodeLab(page);

    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByText("Runner offline", { exact: true })).toBeVisible();
    await expect(page.getByRole("status", { name: "Run status" })).toHaveText(
      "The runner could not be reached. More details are available in Program output.",
    );
    const retry = page.getByRole("button", { name: "Retry run" });
    await expect(retry).toBeVisible();
    await retry.click();

    await expect(page.getByText("Completed", { exact: true })).toBeVisible();
    await expect(page.locator("pre").filter({ hasText: "retry-success" })).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.clientRequestId).not.toBe(requests[0]?.clientRequestId);
  });

  test("an indeterminate result checks the same saved request instead of duplicating it", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "runner interaction contract is exercised once in Chromium");
    const requests: RunnerRequest[] = [];
    await page.route("**/api/code/run", async (route) => {
      const input = JSON.parse(route.request().postData() ?? "{}") as RunnerRequest;
      requests.push(input);
      if (requests.length === 1) {
        await route.fulfill({
          contentType: "application/json",
          status: 503,
          body: JSON.stringify({
            requestId: input.clientRequestId,
            status: "infrastructure_error",
            code: "RUNNER_INDETERMINATE",
            retryable: true,
            indeterminate: true,
            error: "The runner outcome is not known yet.",
          }),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({ requestId: input.clientRequestId, status: "accepted", stdout: "reconciled-success\n" }),
      });
    });
    await openCodeLab(page);

    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByText("Runner issue", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Check run again" }).click();

    await expect(page.locator("pre").filter({ hasText: "reconciled-success" })).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.clientRequestId).toBe(requests[0]?.clientRequestId);
  });

  test("the editor and output remain compact without horizontal overflow at desktop and 375px", async ({ page }, testInfo) => {
    test.skip(!["chromium", "mobile-safari"].includes(testInfo.project.name), "desktop Chromium and mobile Safari regression");
    if (testInfo.project.name === "mobile-safari") {
      await page.setViewportSize({ width: 375, height: 812 });
    }
    await page.route("**/api/code/run", async (route) => {
      const input = JSON.parse(route.request().postData() ?? "{}") as RunnerRequest;
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          requestId: input.clientRequestId,
          status: "accepted",
          stdout: Array.from({ length: 120 }, (_, index) => `layout-ok-${index + 1}`).join("\n"),
        }),
      });
    });
    await openCodeLab(page);
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.locator("pre").filter({ hasText: "layout-ok" })).toBeVisible();

    const codeLab = page.locator('div[class*="codeLab"]').first();
    const editorSurface = codeLab.locator('.monaco-editor, [class*="editorFallback"], [class*="editorLoading"]').first();
    await expect(editorSurface).toBeVisible();
    const editorBox = await editorSurface.boundingBox();
    expect(editorBox?.height ?? 0).toBeGreaterThanOrEqual(250);
    expect(editorBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(342);

    const geometry = await codeLab.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      right: element.getBoundingClientRect().right,
      viewportWidth: window.innerWidth,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.documentClientWidth + 1);
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Runner language" })).toBeVisible();

    const output = page.getByRole("region", { name: "Program output" });
    const outputGeometry = await output.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      tabIndex: element.tabIndex,
    }));
    expect(outputGeometry.scrollHeight).toBeGreaterThan(outputGeometry.clientHeight);
    expect(outputGeometry.clientHeight).toBeLessThanOrEqual(362);
    expect(outputGeometry.tabIndex).toBe(0);

    if (testInfo.project.name === "mobile-safari") {
      const selectFontSize = await page.getByRole("combobox", { name: "Runner language" }).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
      const stdinFontSize = await page.getByRole("textbox", { name: /Program input stdin/i }).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
      expect(selectFontSize).toBeGreaterThanOrEqual(16);
      expect(stdinFontSize).toBeGreaterThanOrEqual(16);
    }
  });
});
