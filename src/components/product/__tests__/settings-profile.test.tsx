import { selectOption } from "@/test/select-option";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "../settings-view";
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const profile = { name: "Actual Learner", bio: "My current bio", analogyFrequency: "neutral", cohortVisibility: "hidden", cohortAlias: "learner-123", cohortConsent: true, cohortVersion: 0, profileVersion: 1 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("persisted settings profile", () => {
  it("loads the current user, saves trimmed values, and refreshes the shell", async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => String(url) === "/api/settings/profile"
      ? json({ profile: init?.method === "PATCH" ? { ...profile, name: "New Name", bio: "New bio", analogyFrequency: "frequent" } : profile })
      : json({ credentials: [] }));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<SettingsView initialTab="profile" />);
    const name = await screen.findByDisplayValue("Actual Learner");
    expect(screen.queryByDisplayValue("Aarav Rao")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Bio")).toHaveValue(profile.bio);
    await user.clear(name); await user.type(name, "  New Name  ");
    await user.clear(screen.getByLabelText("Bio")); await user.type(screen.getByLabelText("Bio"), "New bio");
    await selectOption(user, screen.getByLabelText("Analogy preference"), "frequent");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByText("Profile saved.");
    const call = fetch.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ name: "New Name", bio: "New bio", analogyFrequency: "frequent", cohortVisibility: "hidden" });
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("shows load failure and allows retry without demo defaults", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => String(url) === "/api/settings/profile" ? json({ error: "Profile unavailable." }, 503) : json({ credentials: [] })));
    render(<SettingsView initialTab="profile" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Profile unavailable.");
    expect(screen.queryByDisplayValue("Aarav Rao")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry profile" })).toBeEnabled();
  });
  it("keeps edits and displays save errors without claiming success", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => String(url) === "/api/settings/profile" ? init?.method === "PATCH" ? json({ error: "Save failed." }, 503) : json({ profile }) : json({ credentials: [] })));
    render(<SettingsView initialTab="profile" />);
    await screen.findByDisplayValue(profile.name);
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed.");
    expect(screen.queryByText("Profile saved.")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save profile" })).toBeEnabled());
  });
});
