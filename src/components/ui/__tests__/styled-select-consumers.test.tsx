import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ProfileSettingsPanel } from "../../product/profile-settings-panel";
import { SettingsView } from "../../product/settings-view";
import { AdminAiModels } from "../../admin/admin-ai-models";
import { ExamCatalog } from "../../exams/exam-catalog";
import { ModuleProjectStudio } from "../../projects/module-project-studio";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/settings" }));
const profile = { name: "Learner", bio: "", analogyFrequency: "helpful", cohortVisibility: "hidden", cohortAlias: null, cohortConsent: false, profileVersion: 1, cohortVersion: 0 };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it("opens a themed Settings analogy list and saves the same value", async () => {
  const fetch = vi.fn(async () => json({ profile }));
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(<ProfileSettingsPanel />);
  const trigger = await screen.findByLabelText("Analogy preference");
  await user.click(trigger);
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: "Frequent" }));
  await user.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/settings/profile", expect.objectContaining({ body: expect.stringContaining('"analogyFrequency":"frequent"') })));
});

it("opens the theme list and persists high contrast", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ credentials: [] })));
  const user = userEvent.setup();
  render(<SettingsView initialTab="accessibility" />);
  const trigger = screen.getByRole("combobox", { name: "Interface theme and contrast" });
  await waitFor(() => expect(trigger).toBeEnabled());
  await user.click(trigger);
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: "High contrast" }));
  expect(document.documentElement.dataset.contrast).toBe("more");
});

it("keeps cohort sharing disabled without privacy consent in the themed list", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ profile })));
  const user = userEvent.setup();
  render(<ProfileSettingsPanel />);
  await user.click(await screen.findByLabelText("Public cohort fields"));
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Alias only" })).toHaveAttribute("aria-disabled", "true");
  await user.click(screen.getByRole("option", { name: "Alias only" }));
  await user.keyboard("{Escape}");
  expect(screen.getByLabelText("Public cohort fields")).toHaveTextContent("Hidden profile");
});

it("opens admin AI save status without allowing unverified models", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ providers: [{ provider: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", version: 2, hasPlatformKey: false, model: "test/model", priority: 1, verification: "untested", source: "admin" }] })));
  const user = userEvent.setup();
  render(<AdminAiModels />);
  await user.click(await screen.findByLabelText("Save status"));
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Verified" })).toHaveAttribute("aria-disabled", "true");
  await user.keyboard("{Escape}");
  expect(screen.getByLabelText("Save status")).toHaveFocus();
});

it("opens the exam course filter and keeps the selected course", async () => {
  const fetch = vi.fn(async () => json({ exams: [{ courseId: "javascript", courseTitle: "JavaScript + React", moduleId: "js.basics", moduleTitle: "Basics", summary: "", skillCount: 1, durationMinutes: 10, readiness: "unready", activeSessionId: null, latestResult: null, retake: { eligible: false, reason: "unready", requiresRemediation: false, nextEligibleAt: null }, masteryRecheck: null }] }));
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(<ExamCatalog />);
  await screen.findByRole("heading", { name: "Basics" });
  await user.click(screen.getByLabelText("Course"));
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: "JavaScript + React" }));
  expect(screen.getByLabelText("Course")).toHaveTextContent("JavaScript + React");
  expect(screen.getByRole("heading", { name: "Basics" })).toBeInTheDocument();
});

it("opens the project course filter as an accessible list", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ projects: [] })));
  const user = userEvent.setup();
  render(<ModuleProjectStudio />);
  await user.click(await screen.findByLabelText("Filter by course"));
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.getByLabelText("Filter by course")).toHaveFocus();
});
