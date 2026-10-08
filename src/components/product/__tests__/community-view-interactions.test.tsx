import userEvent from "@testing-library/user-event";
import { selectOption } from "@/test/select-option";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommunityUnavailable, CommunityView } from "../community-view";

const badgeId = "b2000000-0000-4000-8000-000000000001";
const projectId = "b2000000-0000-4000-8000-000000000002";
const settings = {
  policyVersion: "enrollment-disclosure-2026-07-12.v2",
  consent: { cohortProfile: true, leaderboard: false },
  live: false,
  profile: { alias: "learner-safe", bio: "", isPublished: false, showBio: false, showStreak: false, showMasterySummary: false, rowVersion: 0 },
  badges: [{ id: badgeId, title: "Evidence Badge", description: "Safe evidence description", icon: "medal", selected: false }],
  projects: [{ id: projectId, title: "Safe Project", summary: "A selected safe project summary.", status: "reviewed", selected: false }],
  availableAggregates: { streak: 4, masteredConcepts: 3 },
  livePreview: null,
  exclusionNotice: "Email, names, scores, raw hours, attempts, failures, hints, code, chat, provider use, and session data are never fields.",
};
const community = {
  profiles: [],
  leaderboards: {
    formula: { version: "cohort-score-2026-07.v1", components: { consistency: "Capped consistency." }, excludedSignals: ["completion speed"] },
    weekly: { period: { key: "weekly:2026-07-06" }, entries: [] },
    allTime: { period: { key: "all-time" }, entries: [] },
  },
};

describe("community privacy controls", () => {
  it("removes loaded sharing controls when a refresh is locked by a newly active exam", async () => {
    render(<CommunityView />);
    await screen.findByRole("heading", { name: "See growth, not surveillance." });
    vi.mocked(fetch).mockImplementation(async () => Response.json({ code: "EXAM_CLOSED_BOOK", error: "Return to the exam workspace." }, { status: 423 }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh evidence" }));
    expect(await screen.findByRole("heading", { name: /Community is unavailable during your exam/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Publish exact preview/i })).not.toBeInTheDocument();
  });

  it("removes loaded sharing controls when profile publication is blocked during an exam", async () => {
    render(<CommunityView />);
    await screen.findByRole("heading", { name: "See growth, not surveillance." });
    vi.mocked(fetch).mockImplementation(async () => Response.json({ code: "EXAM_CLOSED_BOOK", error: "Return to the exam workspace." }, { status: 423 }));
    fireEvent.click(screen.getByRole("button", { name: /Publish exact preview/i }));
    expect(await screen.findByRole("heading", { name: /Community is unavailable during your exam/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "See growth, not surveillance." })).not.toBeInTheDocument();
  });

  it("shows a distinct fail-closed state when exam status cannot be verified", async () => {
    vi.mocked(fetch).mockImplementation(async () => Response.json({ code: "EXAM_STATE_UNAVAILABLE", error: "Exam state could not be verified." }, { status: 503 }));
    render(<CommunityView />);
    expect(await screen.findByRole("heading", { name: "Community is temporarily unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Publish exact preview/i })).not.toBeInTheDocument();
  });
  it.each(["/api/community", "/api/community/profile"])("shows exam unavailability instead of sharing controls when %s is locked", async (lockedUrl) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === lockedUrl) return Response.json({ code: "EXAM_CLOSED_BOOK", error: "Return to the exam workspace." }, { status: 423 });
      return Response.json(url === "/api/community/profile" ? { settings } : community);
    }));
    render(<CommunityView />);
    expect(await screen.findByRole("heading", { name: /Community is unavailable during your exam/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Return to exam workspace/i })).toHaveAttribute("href", "/exams");
    expect(screen.queryByRole("button", { name: /Publish exact preview/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Loading the private cohort/i })).not.toBeInTheDocument();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("crypto", { randomUUID: () => "b3000000-0000-4000-8000-000000000001" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/community/profile" && init?.method === "PATCH") {
        return new Response(JSON.stringify({ settings: { ...settings, live: true, profile: { ...settings.profile, rowVersion: 1, isPublished: true } } }), { status: 200 });
      }
      if (url === "/api/community/profile") return new Response(JSON.stringify({ settings }), { status: 200 });
      if (url === "/api/community") return new Response(JSON.stringify(community), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
  });

  it("previews alias-only defaults and sends only explicit badge/project selections", async () => {
    render(<CommunityView />);
    expect(await screen.findByRole("heading", { name: "See growth, not surveillance." })).toBeInTheDocument();
    expect(screen.getByText("learner-safe")).toBeInTheDocument();
    expect(screen.queryByText(/Private Legal Name|@integration\.invalid/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Evidence Badge/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Safe Project/ }));
    fireEvent.click(screen.getByRole("button", { name: /Publish exact preview/ }));
    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls;
      const patch = calls.find(([url, init]) => String(url) === "/api/community/profile" && init?.method === "PATCH");
      expect(patch).toBeDefined();
      const body = JSON.parse(String(patch![1]!.body));
      expect(body).toMatchObject({ publish: true, alias: "learner-safe", selectedAchievementIds: [badgeId], selectedProjectIds: [projectId] });
      expect(JSON.stringify(body)).not.toMatch(/email|score|hours|attempt|hint|code|chat|provider|session/i);
    });
  });

  it("withdraws cohort consent and joins/leaves the leaderboard", async () => {
    const consentBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/privacy/consents" && init?.method === "POST") {
        consentBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "/api/community/profile") return new Response(JSON.stringify({ settings }), { status: 200 });
      if (url === "/api/community") return new Response(JSON.stringify(community), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    render(<CommunityView />);
    await screen.findByRole("heading", { name: "See growth, not surveillance." });

    fireEvent.click(screen.getByRole("button", { name: "Withdraw cohort consent" }));
    await waitFor(() => expect(consentBodies).toHaveLength(1));
    expect(consentBodies[0]).toMatchObject({ purpose: "cohort_profile", decision: "withdrawn" });
  });

  it("joins then leaves the leaderboard once cohort consent is active", async () => {
    const consentBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/privacy/consents" && init?.method === "POST") {
        consentBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "/api/community/profile") return new Response(JSON.stringify({ settings }), { status: 200 });
      if (url === "/api/community") return new Response(JSON.stringify(community), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    render(<CommunityView />);
    await screen.findByRole("heading", { name: "See growth, not surveillance." });

    fireEvent.click(screen.getByRole("button", { name: "Join leaderboard" }));
    await waitFor(() => expect(consentBodies).toHaveLength(1));
    expect(consentBodies[0]).toMatchObject({ purpose: "leaderboard", decision: "accepted" });
  });

  it("saves a private draft without publishing", async () => {
    const patchBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/community/profile" && init?.method === "PATCH") {
        patchBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ settings }), { status: 200 });
      }
      if (url === "/api/community/profile") return new Response(JSON.stringify({ settings }), { status: 200 });
      if (url === "/api/community") return new Response(JSON.stringify(community), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    render(<CommunityView />);
    await screen.findByRole("heading", { name: "See growth, not surveillance." });
    fireEvent.click(screen.getByRole("button", { name: "Save private draft" }));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toMatchObject({ publish: false });
    expect(await screen.findByText(/saved privately/i)).toBeInTheDocument();
  });

  it("shows a leaderboard entry, switches to all-time, and surfaces a consent failure", async () => {
    const scoredCommunity = {
      ...community,
      leaderboards: {
        ...community.leaderboards,
        weekly: { period: { key: "weekly:2026-07-06" }, entries: [{ rank: 1, publicId: "p1", alias: "top-learner", totalPoints: 42, components: { newMastery: 3, projects: 1, consistency: 2 }, counts: {} }] },
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/privacy/consents" && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "Consent service unavailable." }), { status: 503 });
      }
      if (url === "/api/community/profile") return new Response(JSON.stringify({ settings }), { status: 200 });
      if (url === "/api/community") return new Response(JSON.stringify(scoredCommunity), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    render(<CommunityView />);
    await screen.findByText("top-learner");
    await selectOption(userEvent.setup(), screen.getByLabelText("Leaderboard period"), "allTime");
    expect(await screen.findByText("No opted-in entries")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Withdraw cohort consent" }));
    await waitFor(() => expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("Consent service unavailable."))).toBe(true));
  });

  it("surfaces a load failure for the cohort view", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/community/profile") return new Response(JSON.stringify({ error: "Profile service unavailable." }), { status: 503 });
      if (url === "/api/community") return new Response(JSON.stringify(community), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    render(<CommunityView />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Profile service unavailable.");
  });

  it("renders the explicit fail-closed unavailable view", () => {
    render(<CommunityUnavailable />);
    expect(screen.getByRole("heading", { name: "Community sharing is not enabled yet." })).toBeInTheDocument();
  });
});
