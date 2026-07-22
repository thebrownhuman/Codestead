import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import {
  AccessibilitySettingsPage,
  CommunityPage,
  expectMinimumTouchTarget,
  InteractiveLessonPage,
  ModuleProjectsPage,
} from "./pages/learner-experience.pages";

const now = "2026-07-14T08:00:00.000Z";

async function mockCredentials(page: Page) {
  await page.route(/\/api\/credentials(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    status: 200,
    body: JSON.stringify({ credentials: [] }),
  }));
}

async function mockCommunity(page: Page) {
  const battle = {
    id: "30000000-0000-4000-8000-000000000001",
    scope: "weekly",
    competitionKey: "2026-W29",
    title: "Python boundary challenge",
    language: "Python",
    skillKey: "python.control-flow.boundaries",
    challengeKind: "authored_answer",
    maxPoints: 10,
    status: "open",
    startsAt: now,
    endsAt: "2026-07-15T08:00:00.000Z",
    revealAt: "2026-07-15T09:00:00.000Z",
    participantCount: 3,
    submissionCount: 1,
    participant: true,
    submitted: false,
    canJoin: false,
    prompt: {
      instructions: "Choose the reviewed boundary result independently.",
      specification: {
        options: [
          { id: "stop", text: "The loop stops at the declared boundary." },
          { id: "continue", text: "The loop always continues." },
        ],
        multiple: false,
      },
    },
    limitations: "Scores stay sealed until the server reveal time.",
  };

  await page.route(/\/api\/community\/profile(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    status: 200,
    body: JSON.stringify({
      settings: {
        policyVersion: "cohort-sharing-v1",
        consent: { cohortProfile: true, leaderboard: true },
        live: true,
        profile: {
          alias: "ByteBuddy",
          bio: "Learning one boundary at a time.",
          isPublished: true,
          showBio: true,
          showStreak: true,
          showMasterySummary: true,
          rowVersion: 2,
        },
        badges: [{ id: "badge-1", title: "Loop learner", description: "Verified loop evidence.", icon: "award", selected: true }],
        projects: [{ id: "project-1", title: "Tiny planner", summary: "A selected public summary.", status: "reviewed", selected: true }],
        availableAggregates: { streak: 4, masteredConcepts: 7 },
        livePreview: {
          publicId: "public-learner-1",
          alias: "ByteBuddy",
          bio: "Learning one boundary at a time.",
          streak: 4,
          masteredConcepts: 7,
          badges: [{ id: "badge-1", title: "Loop learner", description: "Verified loop evidence.", icon: "award" }],
          projects: [{ id: "project-1", title: "Tiny planner", summary: "A selected public summary.", status: "reviewed" }],
        },
        exclusionNotice: "Email, raw code, attempts, chats, scores, and provider data are excluded.",
      },
    }),
  }));
  await page.route(/\/api\/community(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    status: 200,
    body: JSON.stringify({
      profiles: [{
        publicId: "public-learner-1",
        alias: "ByteBuddy",
        badges: [{ id: "badge-1", title: "Loop learner", description: "Verified loop evidence.", icon: "award" }],
        projects: [],
      }],
      leaderboards: {
        formula: {
          version: "evidence-points-v1",
          components: { newMastery: "New verified mastery is capped.", projects: "Reviewed projects are capped.", consistency: "Consistency uses bounded evidence." },
          excludedSignals: ["speed", "hours", "AI spend"],
        },
        weekly: { period: { key: "2026-W29" }, entries: [{ rank: 1, publicId: "public-learner-1", alias: "ByteBuddy", totalPoints: 12, components: { newMastery: 1, projects: 1, consistency: 1 }, counts: {} }] },
        allTime: { period: { key: "all" }, entries: [] },
      },
    }),
  }));
  await page.route(/\/api\/community\/discussions(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    status: 200,
    body: JSON.stringify({
      groups: [{ id: "group-1", name: "Python practice", description: "Focused peer help.", visibility: "cohort", status: "active", membershipRole: "member", memberCount: 3 }],
      posts: [{ id: "post-1", groupId: "group-1", kind: "help", title: "Why does this loop stop?", body: "I am tracing the boundary before changing code.", rowVersion: 1, createdAt: now, editedAt: null, authorAlias: "ByteBuddy", own: true, replies: [] }],
      nextCursor: null,
      moderation: false,
      privacy: "Closed-cohort content only.",
    }),
  }));
  await page.route(/\/api\/battles(?:\/[^/?]+)?(?:\?.*)?$/, (route) => {
    const detail = new URL(route.request().url()).pathname !== "/api/battles";
    return route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify(detail
        ? { battle, resultsRevealed: false, results: [] }
        : {
            battles: [battle],
            sources: [{ activityId: "activity-1", skillKey: battle.skillKey, title: battle.title, language: battle.language, kind: "mcq" }],
            scoring: { version: "battle-score-v1", rule: "Only deterministic reviewed evidence scores.", reveal: "Results remain sealed until reveal time." },
          }),
    });
  });
}

async function mockProjects(page: Page) {
  let startBody: Record<string, unknown> | null = null;
  const brief = {
    templateKey: "python.receipt-sorter.v1",
    publicationStatus: "published",
    moduleTitle: "Collections",
    laymanScenario: "Sort a small pile of receipts into useful groups.",
    problem: "A student needs a clear way to group expenses without losing the original entries.",
    artifact: "A tested command-line receipt sorter.",
    learnerRole: "Implementer and explainer",
    prerequisiteSkillIds: ["python.collections.lists"],
    demonstratedOutcomes: ["Model a receipt", "Group values deterministically"],
    milestones: [{ title: "Model one receipt", purpose: "Name the data clearly.", evidence: "A focused unit test." }],
    acceptanceChecks: [{ id: "AC-1", given: "three valid receipts", when: "the sorter runs", then: "each receipt appears in one category" }],
    reflectionPrompts: ["Which invariant prevents a receipt from disappearing?"],
    stretchGoals: ["Add a date filter after the core checks pass."],
    editorialNotice: "Human-reviewed project brief.",
    awardNotice: "Starting or replaying this project awards no XP, badge, coin, or mastery.",
  };
  const projects = [
    {
      templateId: "40000000-0000-4000-8000-000000000001",
      courseId: "python",
      courseTitle: "Python",
      courseVersion: "1.0.0",
      moduleId: "python-collections",
      title: "Receipt sorter CLI",
      stage: "verified",
      state: "ready",
      reason: "The exact module mastery gate is satisfied.",
      directAwardPolicy: "none",
      brief,
      project: null,
    },
    {
      templateId: "40000000-0000-4000-8000-000000000002",
      courseId: "python",
      courseTitle: "Python",
      courseVersion: "1.0.0",
      moduleId: "python-memory",
      title: "Pointer maze visualizer",
      stage: "verified",
      state: "mastery_locked",
      reason: "Pass the independent module mastery exam first.",
      directAwardPolicy: "none",
      brief: { ...brief, templateKey: "python.pointer-maze.v1", moduleTitle: "Memory model" },
      project: null,
    },
  ];

  await page.route(/\/api\/module-projects(?:\?.*)?$/, (route) => {
    if (route.request().method() === "POST") {
      startBody = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({ result: { project: { id: "project-started-1", status: "planned", updatedAt: now } } }),
      });
    }
    return route.fulfill({ contentType: "application/json", status: 200, body: JSON.stringify({ projects }) });
  });
  await page.route(/\/api\/projects(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    status: 200,
    body: JSON.stringify({ projects: [] }),
  }));
  await page.route(/\/api\/files(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    status: 200,
    body: JSON.stringify({ files: [], quota: { usedBytes: 0, limitBytes: 2 * 1024 ** 3 } }),
  }));

  return { getStartBody: () => startBody };
}

test.describe("new learner experience", () => {
  test("interactive lesson flow turns prediction into practice without inventing evidence", async ({ page }) => {
    const lesson = new InteractiveLessonPage(page);
    await lesson.goto();

    await expect(lesson.revealFirstStep).toBeDisabled();
    await lesson.prediction.fill("I think the checked-out branch receives the named branch changes.");
    await lesson.revealFirstStep.click();
    await expect(page.getByRole("region", { name: "What do you think the computer will do?" })
      .getByRole("status")).toContainText("Prediction saved locally");

    await page.getByRole("button", { name: "Next worked step" }).click();
    await expect(page.getByText(/^Step 2 of \d+$/)).toBeVisible();
    await lesson.preciseExplanation.click();
    await expect(page.getByText("That is the safer mental model.")).toBeVisible();
    await expect(page.getByText("This is a practice-only check; it creates no official evidence.")).toBeVisible();
  });

  test("fixture dashboard links to an honest, interactive roadmap preview", async ({ page }) => {
    // Next's development compiler can broadcast a full Fast Refresh reload
    // while compiling a cold route. Warm the destination before a live page
    // exists so that reload cannot replace the navigation being asserted.
    const roadmapCompilation = await page.request.get("/roadmap");
    expect(roadmapCompilation.ok()).toBe(true);

    await page.goto("/learn");
    await expect(page.getByRole("region", { name: "Learning summary" })).toContainText("Verified XP");
    await expect(page.getByText(/^Level \d+$/)).toBeVisible();
    await page.getByRole("link", { name: "Open full roadmap" }).click();

    await expect(page).toHaveURL(/\/roadmap$/);
    await expect(page.getByRole("complementary", { name: "Curriculum preview data" })).toContainText(
      "progress, mastery, streaks, and review counts remain at zero",
    );
    const journey = page.getByRole("region", { name: "Interactive course journey" });
    expect(await journey.getByRole("article").count()).toBeGreaterThanOrEqual(5);
    await expect(journey.getByRole("progressbar")).toHaveCount(0);
    await expect(journey.getByText("No learner evidence is shown.")).not.toHaveCount(0);

    const foundations = journey.getByRole("article").filter({
      has: page.getByRole("heading", { name: "Programming foundations" }),
    });
    await foundations.getByText(/^Explore \d+ levels?$/).click();
    await expect(foundations.getByRole("list")).toBeVisible();
  });

  test("mobile community keeps discussions reachable and battle results sealed", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mockCommunity(page);
    const community = new CommunityPage(page);
    await community.goto();

    await expect(page.getByText("ByteBuddy", { exact: true })).not.toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Why does this loop stop?" })).toBeVisible();
    await community.discussTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(community.battleTab).toBeFocused();
    await expect(community.battleTab).toHaveAttribute("aria-selected", "true");

    const battle = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: "Python boundary challenge" }),
    });
    await battle.getByRole("button", { name: "View challenge" }).click();
    await expect(battle.getByText("Results are sealed")).toBeVisible();
    await expect(page.getByText("Read-only on phone")).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit once" })).toHaveCount(0);
    await expectMinimumTouchTarget(community.battleTab);
    await expectMinimumTouchTarget(battle.getByRole("button", { name: "View challenge" }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

    await page.waitForLoadState("networkidle");
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
  });

  test("module projects expose the brief, enforce mastery gates, and start without an award", async ({ page }) => {
    const state = await mockProjects(page);
    const projects = new ModuleProjectsPage(page);
    await projects.goto();

    const ready = projects.project("Receipt sorter CLI");
    const locked = projects.project("Pointer maze visualizer");
    await expect(ready.getByRole("button", { name: "Start after mastery" })).toBeEnabled();
    await expect(locked.getByRole("button", { name: "Start after mastery" })).toBeDisabled();
    await ready.getByRole("button", { name: "Open brief" }).click();
    await expect(ready.getByRole("heading", { name: "Your mission" })).toBeVisible();
    await expect(ready.getByRole("heading", { name: "Acceptance checks" })).toBeVisible();
    await expect(ready).toContainText("awards no XP, badge, coin, or mastery");

    await ready.getByRole("button", { name: "Start after mastery" }).click();
    await expect(ready.getByRole("link", { name: "Open project" })).toBeVisible();
    expect(state.getStartBody()).toMatchObject({
      templateId: "40000000-0000-4000-8000-000000000001",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });

    await page.waitForLoadState("networkidle");
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
  });

  test("accessibility preferences apply immediately and survive a reload", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mockCredentials(page);
    const settings = new AccessibilitySettingsPage(page);
    await settings.goto();
    await settings.chooseMaximumComfort();

    await expect.poll(() => page.evaluate(() => ({
      textSize: document.documentElement.dataset.textSize,
      motion: document.documentElement.dataset.motion,
      theme: document.documentElement.dataset.interfaceTheme,
      contrast: document.documentElement.dataset.contrast,
      editorFont: document.documentElement.dataset.codeEditorFont,
      rootFontSize: document.documentElement.style.getPropertyValue("--user-root-font-size"),
      editorFontSize: document.documentElement.style.getPropertyValue("--code-editor-font-size"),
    }))).toEqual({
      textSize: "200",
      motion: "reduce",
      theme: "contrast",
      contrast: "more",
      editorFont: "18",
      rootFontSize: "200%",
      editorFontSize: "18px",
    });

    await page.reload();
    await expect(settings.textSize).toHaveValue("200");
    await expect(settings.motion).toHaveValue("reduce");
    await expect(settings.theme).toHaveValue("contrast");
    await expect(settings.editorFont).toHaveValue("18");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });

  test("an unknown learner course fails closed and provides a recovery path", async ({ page }) => {
    await page.goto("/courses/course-that-does-not-exist");
    await expect(page).toHaveURL(/\/courses\/course-that-does-not-exist$/);
    const state = page.getByRole("region", { name: "This route does not have that learning step." });
    await expect(state).toContainText("Your saved learning evidence has not changed.");
    await state.getByRole("link", { name: "Back to learning home" }).click();
    await expect(page).toHaveURL(/\/learn$/);
  });
});
