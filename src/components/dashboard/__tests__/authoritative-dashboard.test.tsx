import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthoritativeDashboardData, RoadmapState } from "@/lib/dashboard/learner";
import { AuthoritativeDashboard } from "../authoritative-dashboard";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

const base: AuthoritativeDashboardData = {
  firstName: "Leena",
  masteryPercent: 72,
  averageConfidencePercent: 81,
  masteredSkills: 9,
  reviews: [{ id: "r1", title: "Array bounds", course: "C", href: "/courses/c/skills/c.arrays.bounds", due: "Now", confidence: 70, reason: "Delayed review" }],
  reviewsDueCount: 1,
  meaningfulThisWeek: 6,
  streak: 3,
  weeklyActivity: [0, 1, 2, 0, 1, 1, 1],
  completedLessons: 4,
  rewards: {
    rewardPolicyVersion: "reward-ledger-2026-07.v1",
    challengePolicyVersion: "challenge-xp-2026-07.v1",
    totalXp: 280,
    level: {
      formulaVersion: "level-curve-2026-07.v1",
      totalXp: 280,
      level: 2,
      currentLevelStartsAt: 100,
      nextLevelStartsAt: 300,
      xpIntoLevel: 180,
      xpToNextLevel: 20,
    },
    coins: {
      enabled: false,
      balance: 0,
      policyNote: "Coins are reserved for a future reviewed purpose. This policy always awards zero coins and exposes no spending path.",
    },
    eventCount: 5,
    challenges: {
      weekly: {
        id: "challenge-xp-2026-07.v1:weekly:2026-07-13",
        kind: "weekly",
        title: "Weekly evidence challenge",
        description: "Evidence challenge.",
        policyVersion: "challenge-xp-2026-07.v1",
        period: { kind: "weekly", timezone: "Asia/Kolkata", startLocalDate: "2026-07-13", endLocalDateExclusive: "2026-07-20", key: "weekly:2026-07-13" },
        targetXp: 250,
        earnedXp: 180,
        qualifyingRewards: 3,
        completed: false,
        progressPercent: 72,
        completionReward: null,
      },
      monthly: {
        id: "challenge-xp-2026-07.v1:monthly:2026-07-01",
        kind: "monthly",
        title: "Monthly evidence challenge",
        description: "Evidence challenge.",
        policyVersion: "challenge-xp-2026-07.v1",
        period: { kind: "monthly", timezone: "Asia/Kolkata", startLocalDate: "2026-07-01", endLocalDateExclusive: "2026-08-01", key: "monthly:2026-07-01" },
        targetXp: 1_000,
        earnedXp: 280,
        qualifyingRewards: 5,
        completed: false,
        progressPercent: 28,
        completionReward: null,
      },
    },
  },
  strongTopics: [{ id: "c.arrays.bounds", title: "Array bounds", confidence: 86 }],
  needsReviewTopics: [{ id: "c.pointers.aliasing", title: "Pointer aliasing", confidence: 54, reason: "Mastery status requires review." }],
  next: { title: "Trace a loop", course: "C", reason: "Due prerequisite", href: "/courses/c/skills/c.loops.trace" },
  courses: [{ enrollmentId: "enrollment-c", id: "c", title: "C", contentVersion: "0.1.0", progressState: "verified", progress: 25, mastered: 5, total: 20, stage: "beta", status: "active" }],
  roadmap: { state: "ready", selectedTrackIds: ["c"], unavailableTrackIds: [], selectedTrackPreviews: [] },
  degraded: false,
};

function emptyDashboard(
  state: RoadmapState,
  roadmap: Partial<AuthoritativeDashboardData["roadmap"]> = {},
): AuthoritativeDashboardData {
  return {
    ...base,
    next: null,
    courses: [],
    reviews: [],
    roadmap: {
      state,
      selectedTrackIds: [],
      unavailableTrackIds: [],
      selectedTrackPreviews: [],
      ...roadmap,
    },
  };
}

function mockResponse(ok: boolean, body = "") {
  return { ok, text: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

afterEach(() => {
  refresh.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AuthoritativeDashboard", () => {
  it("renders persisted evidence and a populated roadmap instead of demo learner claims", () => {
    render(<AuthoritativeDashboard data={base} />);

    expect(screen.getByRole("heading", { name: /welcome back, leena/i })).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Learning summary" })).getByText("72%"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("4").length).toBeGreaterThan(0);
    expect(screen.getByText("Trace a loop")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Your learning plans" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open full roadmap/i })).toHaveAttribute("href", "/roadmap");
    expect(screen.getByRole("heading", { name: "C" })).toBeInTheDocument();
    expect(screen.getByText("active path")).toBeInTheDocument();
    expect(screen.getByText("beta curriculum")).toBeInTheDocument();
    expect(screen.queryByText(/Aarav/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /No courses selected|ready to create|temporarily unavailable/i })).not.toBeInTheDocument();
  });

  it("labels course progress unavailable when the exact versioned manifest is absent", () => {
    render(<AuthoritativeDashboard data={{
      ...base,
      courses: [{
        ...base.courses[0]!,
        contentVersion: "0.0.9",
        progressState: "manifest_unavailable",
        progress: 0,
        mastered: 0,
        total: 0,
      }],
    }} />);

    expect(screen.getByText("Progress unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Course version 0\.0\.9 is not available/i)).toBeInTheDocument();
    expect(screen.queryByText("0 of 0 skills proficient or mastered")).not.toBeInTheDocument();
  });

  it("shows evidence-backed topics and only ledger-derived rewards", () => {
    render(<AuthoritativeDashboard data={base} />);

    expect(screen.getByRole("heading", { name: "What to celebrate and tune up" })).toBeInTheDocument();
    expect(screen.getAllByText("Array bounds")).toHaveLength(2);
    expect(screen.getByText("86% confidence")).toBeInTheDocument();
    expect(screen.getByText("Pointer aliasing")).toBeInTheDocument();
    expect(screen.getByText("Mastery status requires review.")).toBeInTheDocument();
    expect(screen.getByText("Level 2")).toBeInTheDocument();
    expect(screen.getByText("280 XP")).toBeInTheDocument();
    expect(screen.getByText("Weekly evidence challenge")).toBeInTheDocument();
    expect(screen.getByText("Coins are not enabled")).toBeInTheDocument();
    expect(screen.queryByText(/coin balance/i)).not.toBeInTheDocument();
  });

  it("shows an honest unavailable reward state instead of guessed values", () => {
    render(<AuthoritativeDashboard data={{ ...base, rewards: null, degraded: true }} />);

    expect(screen.getByText("Reward progress is temporarily unavailable.")).toBeInTheDocument();
    expect(screen.getByText(/No XP, level, challenge, or coin value has been guessed/i)).toBeInTheDocument();
    expect(screen.queryByText("Level 2")).not.toBeInTheDocument();
  });

  it("shows a truthful no-tracks state with one course-selection recovery path", () => {
    render(<AuthoritativeDashboard data={emptyDashboard("no_tracks")} />);

    expect(screen.getByRole("heading", { name: "No courses are selected." })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No courses selected yet" })).toBeInTheDocument();
    expect(screen.getByText(/saved roadmap is created only after a track is selected/i)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "View course catalog" })).toHaveLength(2);
    expect(screen.queryByRole("link", { name: /Open full roadmap/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Verified progress")).not.toBeInTheDocument();
  });

  it("does not claim a plan exists while every selected track awaits publication", () => {
    render(<AuthoritativeDashboard data={emptyDashboard("awaiting_publication", {
      selectedTrackIds: ["future-one", "future-two"],
      unavailableTrackIds: ["future-one", "future-two"],
      selectedTrackPreviews: [
        {
          id: "future-one",
          title: "Systems foundations",
          summary: "A scoped introduction to systems concepts.",
          moduleCount: 4,
          skillCount: 18,
          publicationReady: false,
          href: "/courses/future-one",
        },
        {
          id: "future-two",
          title: "Applied concurrency",
          summary: "A declared concurrency curriculum awaiting editorial review.",
          moduleCount: 3,
          skillCount: 12,
          publicationReady: false,
          href: null,
        },
      ],
    })} />);

    expect(screen.getByRole("heading", { name: "Your selected courses are awaiting publication." })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Selected courses are awaiting publication" })).toBeInTheDocument();
    expect(screen.getByText(/2 selected courses are waiting/i)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "View curriculum previews" })).toHaveLength(2);
    const previews = screen.getByRole("region", { name: "Selected curriculum previews" });
    expect(within(previews).getByRole("heading", { name: "Systems foundations" })).toBeInTheDocument();
    expect(within(previews).getByRole("heading", { name: "Applied concurrency" })).toBeInTheDocument();
    expect(within(previews).getAllByText("Awaiting human review")).toHaveLength(2);
    expect(within(previews).getAllByText("Modules")[0]?.closest("div")).toHaveTextContent("Modules4");
    expect(within(previews).getAllByText("Skills")[0]?.closest("div")).toHaveTextContent("Skills18");
    expect(within(previews).getAllByText(/cannot award progress, mastery, badges, or exam credit/i)).toHaveLength(2);
    expect(within(previews).getByRole("link", { name: "Preview curriculum" })).toHaveAttribute("href", "/courses/future-one");
    expect(within(previews).getByText("Curriculum preview unavailable")).toBeInTheDocument();
    expect(within(previews).getAllByRole("link", { name: "Preview curriculum" })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /Open full roadmap/i })).not.toBeInTheDocument();
  });

  it("shows an honest unavailable projection and refreshes without creating a plan", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthoritativeDashboard data={emptyDashboard("unavailable")} />);

    expect(screen.getByRole("heading", { name: "Roadmap status is temporarily unavailable." })).toBeInTheDocument();
    expect(screen.getAllByText(/progress has not been changed/i)).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("initializes a missing plan with one UUID and refreshes after any successful response", async () => {
    const user = userEvent.setup();
    const success = mockResponse(true, "this body is intentionally malformed");
    const fetchMock = vi.fn().mockResolvedValue(success);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    render(<AuthoritativeDashboard data={emptyDashboard("initialization_required", {
      selectedTrackIds: ["python"],
    })} />);

    expect(screen.getByRole("heading", { name: "Create your saved learning plan." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create roadmap below" })).toHaveAttribute("href", "#roadmap-create-action");
    await user.click(screen.getByRole("button", { name: "Create my roadmap" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/learning/plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: REQUEST_ID }),
    });
    expect(success.text).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reuses the UUID after a malformed error and exposes a recoverable alert", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(false, "<html>upstream failure</html>"))
      .mockResolvedValueOnce(mockResponse(true));
    vi.stubGlobal("fetch", fetchMock);
    const uuid = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    render(<AuthoritativeDashboard data={emptyDashboard("initialization_required", {
      selectedTrackIds: ["python"],
    })} />);

    const button = screen.getByRole("button", { name: "Create my roadmap" });
    await user.click(button);
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be created/i);
    expect(button).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();

    await user.click(button);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ idempotencyKey: REQUEST_ID });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ idempotencyKey: REQUEST_ID });
  });

  it("locks synchronously so a double click cannot create duplicate requests", async () => {
    let resolveRequest!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    render(<AuthoritativeDashboard data={emptyDashboard("initialization_required", {
      selectedTrackIds: ["python"],
    })} />);

    const button = screen.getByRole("button", { name: "Create my roadmap" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Creating roadmap..." })).toBeDisabled();

    await act(async () => resolveRequest(mockResponse(true)));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("uses a bounded server error message without leaking malformed response bodies", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(false, JSON.stringify({
      error: "The selected publication changed. Retry safely.",
      privateDebug: "must not render",
    })));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    render(<AuthoritativeDashboard data={emptyDashboard("initialization_required", {
      selectedTrackIds: ["python"],
    })} />);

    await user.click(screen.getByRole("button", { name: "Create my roadmap" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The selected publication changed. Retry safely.");
    expect(screen.queryByText(/privateDebug|must not render/)).not.toBeInTheDocument();
  });

  it("keeps the privacy disclosure visible in every empty state", () => {
    render(<AuthoritativeDashboard data={{ ...emptyDashboard("no_tracks"), degraded: true }} />);
    expect(screen.getByText(/community rankings and profiles stay hidden/i)).toBeInTheDocument();
  });
});
