import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ProfileSettingsPanel } from "../profile-settings-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => vi.unstubAllGlobals());
const profile = { name: "Learner", bio: "Learning", analogyFrequency: "helpful", cohortVisibility: "hidden", cohortAlias: null, cohortConsent: false, profileVersion: 1, cohortVersion: 0 };

it("groups the profile into cards, keeps interests read-only, and saves with inline feedback", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("onboarding/status") ? { profile: { analogyInterests: [{ label: "Music", category: "music" }] } } : { profile }))));
  render(<ProfileSettingsPanel />);
  const identity = await screen.findByRole("group", { name: "Identity" });
  expect(within(identity).getByLabelText("Display name")).toHaveValue("Learner");
  expect(within(identity).getByLabelText("Bio")).toHaveAccessibleDescription("Private learning bio, up to 280 characters. 8/280");
  expect(screen.getByRole("group", { name: "Learning" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Community" })).toBeInTheDocument();
  expect(await screen.findByText("Music")).not.toHaveAttribute("role", "button");
  expect(screen.queryByRole("button", { name: /remove music/i })).not.toBeInTheDocument();
  const save = screen.getByRole("button", { name: "Save profile" });
  await userEvent.click(save);
  expect(await within(save.parentElement!).findByRole("status")).toHaveTextContent("Profile saved.");
});

it("uses one shared form system across product and admin modules", () => {
  for (const path of ["product/product-pages", "admin/admin", "admin/admin-ai-models"]) {
    expect(readFileSync(`src/components/${path}.module.css`, "utf8")).toContain('from "../ui/form.module.css"');
  }
});
