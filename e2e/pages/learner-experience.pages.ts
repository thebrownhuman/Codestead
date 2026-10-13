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
    this.textSize = page.getByRole("combobox", { name: "Text size", exact: true });
    this.motion = page.getByRole("combobox", { name: "Motion", exact: true });
    this.theme = page.getByRole("combobox", { name: "Interface theme and contrast", exact: true });
    this.editorFont = page.getByRole("combobox", { name: "Code editor font", exact: true });
  }

  async goto() {
    await this.page.goto("/settings?section=accessibility");
    await expect(this.page.getByRole("tab", { name: "Accessibility" })).toHaveAttribute("aria-selected", "true");
  }

  async chooseMaximumComfort() {
    await this.textSize.click();
    await this.page.getByRole("option", { name: "Maximum · 200%", exact: true }).click();
    await this.motion.click();
    await this.page.getByRole("option", { name: "Reduce motion", exact: true }).click();
    await this.theme.click();
    await this.page.getByRole("option", { name: "High contrast", exact: true }).click();
    await this.editorFont.click();
    await this.page.getByRole("option", { name: "18px", exact: true }).click();
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
