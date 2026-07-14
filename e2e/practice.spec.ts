import { expect, test } from "@playwright/test";

test("reviewed practice persists assistance and renders deterministic remediation without private keys", async ({ page }) => {
  let createBody: Record<string, unknown> = {};
  let submitBody: Record<string, unknown> = {};
  await page.route("**/api/learning/attempts/*/submit", async (route) => {
    submitBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: "graded",
        attemptId: "50000000-0000-4000-8000-000000000001",
        attemptStatus: "graded",
        score: 0,
        passed: false,
        officialEvidenceRecorded: true,
        masteryAwarded: false,
        progress: null,
        criticalGates: ["distinct_applications"],
        remediation: { activeTags: [], confirmingProbeTags: ["merge.direction"] },
        feedback: {
          correct: false,
          headline: "Not yet",
          why: "The destination branch receives the source branch changes.",
          misconceptionTags: ["merge.direction"],
          remediation: [{
            tag: "merge.direction",
            explanation: "Name the checked-out destination before identifying the source branch.",
            retryPrompt: "State the destination, then the source, before choosing the command.",
          }],
          independent: false,
          assistanceLevel: "A1",
          solutionRevealed: false,
          solution: null,
          nextAction: "retry_fresh",
        },
        reviewDueAt: null,
      }),
    });
  });
  await page.route("**/api/learning/attempts/*/help", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: "ready",
        attemptId: "50000000-0000-4000-8000-000000000001",
        helpStep: 1,
        assistanceLevel: "A1",
        solutionRevealed: false,
        help: { kind: "hint", content: "Start with the branch that is currently checked out.", answer: null },
        requiresFreshAttempt: false,
        idempotent: false,
      }),
    });
  });
  await page.route("**/api/learning/attempts", async (route) => {
    createBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        state: "ready",
        attempt: {
          id: "50000000-0000-4000-8000-000000000001",
          kind: "practice",
          attemptNumber: 1,
          status: "in_progress",
          contentVersion: "reviewed-v1",
        },
        activity: {
          id: "20000000-0000-4000-8000-000000000001",
          slug: "git-merge-choice-a",
          skillId: "git.branches.merge",
          courseVersion: "reviewed-v1",
          languageContext: "conceptual",
          specification: {
            kind: "mcq",
            itemKey: "git-merge-choice-a",
            title: "Choose the merge direction",
            prompt: "You are on main and want to bring in feature. Which description is correct?",
            options: [
              { id: "correct", text: "main receives the commits reachable from feature" },
              { id: "wrong", text: "feature receives main because feature is named in the command" },
            ],
            multiple: false,
            artifact: [],
            template: null,
            gaps: [],
            starterCode: null,
            language: null,
            help: { totalSteps: 4, hintSteps: 1, hasAlternateExplanation: true, hasWorkedExample: true, hasSolution: true },
          },
        },
        idempotent: false,
      }),
    });
  });

  await page.goto("/courses/git-tooling/skills/git.branches.merge");
  await page.getByRole("tab", { name: "Practice" }).click();
  await expect(page.getByText(/draft preview items? (?:is|are) intentionally excluded/i)).toBeVisible();
  await page.getByRole("button", { name: "Start practice" }).click();
  await expect(page.getByRole("heading", { name: "Choose the merge direction" })).toBeVisible();

  await expect(page.getByText("Start with the branch that is currently checked out.")).toHaveCount(0);
  await page.getByRole("button", { name: "Show next help" }).click();
  await expect(page.getByText("Start with the branch that is currently checked out.")).toBeVisible();
  await page.getByLabel("feature receives main because feature is named in the command").check();
  await page.getByRole("button", { name: "Check answer" }).click();

  await expect(page.getByRole("heading", { name: "Not yet" })).toBeVisible();
  await expect(page.getByText("Name the checked-out destination before identifying the source branch.")).toBeVisible();
  await expect(page.getByText(/Assisted practice evidence saved; it cannot prove mastery/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try a fresh question" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Report feedback mismatch" })).toHaveAttribute("href", /skillId=git\.branches\.merge/);

  expect(createBody).toMatchObject({ skillId: "git.branches.merge", kind: "practice" });
  expect(String(createBody.idempotencyKey)).toMatch(/^practice-/);
  expect(submitBody).toEqual({
    itemKey: "git-merge-choice-a",
    responseRevision: 1,
    answer: { value: "wrong" },
    assistanceLevel: "A0",
    solutionRevealed: false,
  });
  await expect(page.locator("body")).not.toContainText(/acceptedAnswers|hiddenTests|referenceSolution|privateAuthorNotes/);
});

test("the inline topic checkpoint requests only an official quiz and manages focus through grading", async ({ page }) => {
  let createBody: Record<string, unknown> = {};
  await page.route("**/api/learning/attempts/*/submit", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: "graded",
        attemptId: "50000000-0000-4000-8000-000000000009",
        attemptStatus: "graded",
        score: 1,
        passed: true,
        officialEvidenceRecorded: true,
        masteryAwarded: false,
        progress: null,
        criticalGates: [],
        remediation: { activeTags: [], confirmingProbeTags: [] },
        feedback: {
          correct: true,
          headline: "Correct",
          why: "The checked-out destination receives the reviewed source branch changes.",
          misconceptionTags: [],
          remediation: [],
          independent: true,
          assistanceLevel: "A0",
          solutionRevealed: false,
          solution: null,
          nextAction: "continue",
        },
        reviewDueAt: null,
      }),
    });
  });
  await page.route("**/api/learning/attempts", async (route) => {
    createBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        state: "ready",
        attempt: {
          id: "50000000-0000-4000-8000-000000000009",
          kind: "quiz",
          attemptNumber: 1,
          status: "in_progress",
          contentVersion: "reviewed-v1",
        },
        activity: {
          id: "20000000-0000-4000-8000-000000000009",
          slug: "git-merge-checkpoint-a",
          skillId: "git.branches.merge",
          courseVersion: "reviewed-v1",
          languageContext: "conceptual",
          specification: {
            kind: "mcq",
            itemKey: "git-merge-checkpoint-a",
            title: "Checkpoint: choose the merge direction",
            prompt: "You are on main and want to bring in feature. What happens?",
            options: [
              { id: "correct", text: "main receives the commits reachable from feature" },
              { id: "wrong", text: "feature receives main" },
            ],
            multiple: false,
            artifact: [],
            template: null,
            gaps: [],
            starterCode: null,
            language: null,
            help: { totalSteps: 2, hintSteps: 1, hasAlternateExplanation: false, hasWorkedExample: false, hasSolution: true },
          },
        },
        idempotent: false,
      }),
    });
  });

  await page.goto("/courses/git-tooling/skills/git.branches.merge");
  await expect(page.getByText("Topic checkpoint · one reviewed MCQ")).toBeVisible();
  await page.getByRole("button", { name: "Start checkpoint" }).click();
  const question = page.getByRole("heading", { name: "Checkpoint: choose the merge direction" });
  await expect(question).toBeFocused();
  await expect(page.getByText("official MCQ")).toBeVisible();
  const checkpoint = page.getByRole("region", { name: "One reviewed MCQ for this topic" });
  await expect(checkpoint.getByRole("button", { name: /help|hint/i })).toHaveCount(0);

  await page.getByLabel("main receives the commits reachable from feature").check();
  await page.getByRole("button", { name: "Check answer" }).click();
  await expect(page.getByRole("heading", { name: "Correct", exact: true })).toBeFocused();
  await expect(page.getByText(/checkpoint response was saved as deterministic official evidence/i)).toBeVisible();
  expect(createBody).toMatchObject({ skillId: "git.branches.merge", kind: "quiz" });
  expect(String(createBody.idempotencyKey)).toMatch(/^checkpoint-/);
  await expect(page.locator("body")).not.toContainText(/acceptedAnswers|hiddenTests|referenceSolution|privateAuthorNotes/);
});
