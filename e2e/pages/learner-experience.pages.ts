import { expect, type Locator, type Page } from "@playwright/test";

export class InteractiveLessonPage {
  readonly page: Page;
  readonly prediction: Locator;
  readonly revealFirstStep: Locator;
  readonly preciseExplanation: Locator;

  constructor(page: Page) {
    this.page = page;
    this.prediction = page.getByLabel("Your prediction");
    this.revealFirstStep = page.getByRole("button", { name: "Reveal the first step" });
    this.preciseExplanation = page.getByRole("button", { name: "Choose the precise explanation" });
  }

  async goto() {
    await this.page.goto("/courses/git-tooling/skills/git.branches.merge");
    await expect(this.page.getByTestId("authored-lesson")).toBeVisible();
  }
}

export class AccessibilitySettingsPage {
  readonly page: Page;
  readonly textSize: Locator;
  readonly motion: Locator;
  readonly theme: Locator;
  readonly editorFont: Locator;

  constructor(page: Page) {
    this.page = page;
    this.textSize = page.getByLabel("Text size");
    this.motion = page.getByLabel("Motion");
    this.theme = page.getByLabel("Interface theme and contrast");
    this.editorFont = page.getByLabel("Code editor font");
  }

  async goto() {
    await this.page.goto("/settings?section=accessibility");
    await expect(this.page.getByRole("tab", { name: "Accessibility" })).toHaveAttribute("aria-selected", "true");
  }

  async chooseMaximumComfort() {
    await this.textSize.selectOption("200");
    await this.motion.selectOption("reduce");
    await this.theme.selectOption("contrast");
    await this.editorFont.selectOption("18");
  }
}

export class CommunityPage {
  readonly page: Page;
  readonly discussTab: Locator;
  readonly battleTab: Locator;

  constructor(page: Page) {
    this.page = page;
    this.discussTab = page.getByRole("tab", { name: "Discuss & help" });
    this.battleTab = page.getByRole("tab", { name: "Battles" });
  }

  async goto() {
    await this.page.goto("/community");
    await expect(this.page.getByRole("heading", { name: "Community spaces & coding battles" })).toBeVisible();
  }
}

export class ModuleProjectsPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto() {
    await this.page.goto("/projects");
    await expect(this.page.getByRole("heading", { name: "Module project arcade" })).toBeVisible();
  }

  project(title: string) {
    return this.page.getByRole("article").filter({
      has: this.page.getByRole("heading", { name: title }),
    });
  }
}

export async function expectMinimumTouchTarget(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, "visible control must expose geometry").not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}
