import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import type { CatalogTrackViewState, CourseManifest } from "@/lib/content";
import type { AuthoritativeDashboardData } from "@/lib/dashboard/learner";
import { ReviewQueue } from "../review-queue";
import { RoadmapView } from "../roadmap-view";
import { CommunityUnavailable } from "../community-view";

const dashboard: AuthoritativeDashboardData = {
  firstName: "Leena",
  masteryPercent: 60,
  averageConfidencePercent: 75,
  masteredSkills: 3,
  reviews: [{ id: "review-1", title: "Array bounds", course: "C", href: "/courses/c/skills/c.arrays.bounds", due: "Now", confidence: 75, reason: "Delayed review" }],
  reviewsDueCount: 1,
  meaningfulThisWeek: 5,
  streak: 2,
  weeklyActivity: [0, 1, 1, 1, 0, 1, 1],
  completedLessons: 3,
  strongTopics: [{ id: "c.arrays.bounds", title: "Array bounds", confidence: 84 }],
  needsReviewTopics: [{ id: "c.loops.trace", title: "Loop tracing", confidence: 52, reason: "Mastery status requires review." }],
  next: { title: "Array bounds", course: "C", reason: "Review is due", href: "/courses/c/skills/c.arrays.bounds" },
  courses: [{
    enrollmentId: "enrollment-c",
    id: "c",
    title: "C",
    contentVersion: "0.1.0",
    progressState: "verified",
    progress: 30,
    mastered: 3,
    total: 10,
    stage: "beta",
    status: "active",
    planRevision: {
      revision: 3,
      source: "admin",
      reason: "Assigned loop remediation.",
      createdAt: "2026-07-12T08:00:00.000Z",
    },
  }],
  roadmap: {
    state: "ready",
    selectedTrackIds: ["c"],
    unavailableTrackIds: [],
    selectedTrackPreviews: [],
  },
  rewards: null,
  degraded: false,
};

const course = {
  id: "c",
  title: "C",
  version: "0.1.0",
  status: "beta",
  modules: [{ id: "c.arrays" }],
  coverage_summary: { total_skills: 10 },
} as unknown as CourseManifest;

describe("authoritative roadmap and review projections", () => {
  it("uses persisted course progress and routes change requests", () => {
    render(<RoadmapView courses={[course]} dashboard={dashboard} />);
    expect(screen.getByText("30%")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Request a change" })).toHaveAttribute("href", "/requests");
    expect(screen.getByRole("complementary", { name: "Mentor plan update" })).toHaveTextContent("Mentor plan revision 3");
    expect(screen.getByText("Assigned loop remediation.")).toBeInTheDocument();
    expect(screen.getByText("Your evidence and prerequisite gates were preserved.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Interactive course journey" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "C verified progress" })).toHaveAttribute("aria-valuenow", "30");
    expect(screen.getByText("Explore 1 level")).toBeInTheDocument();
  });

  it("does not label an adaptive engine revision as a mentor edit", () => {
    const adaptiveDashboard: AuthoritativeDashboardData = {
      ...dashboard,
      courses: dashboard.courses.map((item) => ({
        ...item,
        planRevision: item.planRevision
          ? { ...item.planRevision, source: "adaptive" }
          : undefined,
      })),
    };

    render(<RoadmapView courses={[course]} dashboard={adaptiveDashboard} />);
    expect(screen.queryByRole("complementary", { name: "Mentor plan update" })).not.toBeInTheDocument();
  });

  it("renders a labeled zero-evidence preview and deduplicates repeated course ids", () => {
    const previewCourses = [
      course,
      { ...course, title: "Duplicate C manifest" },
      { ...course, id: "python", title: "Python" },
    ] as unknown as CourseManifest[];

    render(<RoadmapView courses={previewCourses} />);
    expect(screen.getByRole("complementary", { name: "Curriculum preview data" })).toHaveTextContent(
      "progress, mastery, streaks, and review counts remain at zero",
    );
    expect(screen.getAllByText("Preview data")).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: /Preview course/i })).toHaveLength(2);
    expect(screen.getAllByRole("heading", { name: "C" })).toHaveLength(1);
    expect(screen.queryByText("Duplicate C manifest")).not.toBeInTheDocument();
    expect(screen.queryByText("62%")).not.toBeInTheDocument();
    expect(screen.queryByText("18%")).not.toBeInTheDocument();
    expect(screen.queryByText("Locked by prerequisites")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("does not pair an enrollment with a different manifest version", () => {
    render(<RoadmapView courses={[course]} dashboard={{
      ...dashboard,
      courses: [{
        ...dashboard.courses[0]!,
        contentVersion: "0.2.0",
        progressState: "manifest_unavailable",
        progress: 0,
        mastered: 0,
        total: 0,
      }],
    }} />);

    expect(screen.getByText("Progress unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Enrollment version 0\.2\.0 is not present/i)).toBeInTheDocument();
    expect(screen.getByText("An exact versioned manifest is required.")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "C verified progress" })).not.toBeInTheDocument();
    expect(screen.queryByText(/evidence-linked skills/i)).not.toBeInTheDocument();
  });

  it("shows no-track guidance without a fake continue-plan link", () => {
    render(<RoadmapView courses={[]} dashboard={{
      ...dashboard,
      next: null,
      courses: [],
      roadmap: { state: "no_tracks", selectedTrackIds: [], unavailableTrackIds: [], selectedTrackPreviews: [] },
    }} />);
    expect(screen.getByRole("heading", { name: "No courses selected yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View course catalog/i })).toHaveAttribute("href", "/courses");
    expect(screen.queryByRole("link", { name: /Continue plan/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/selected courses are waiting/i)).not.toBeInTheDocument();
  });

  it("shows selected curriculum preview cards without repeating the fallback summary", () => {
    const awaitingCatalog: readonly CatalogTrackViewState[] = [
      {
        id: "qt",
        title: "Qt Desktop",
        release: "launch-3",
        scopeBrief: "A future desktop extension.",
        prerequisites: ["cpp"],
        visible: true,
        access: "coming-soon",
        canEnroll: false,
        href: null,
        reason: "Not published yet.",
      },
      {
        id: "hpc",
        title: "High-performance computing",
        release: "launch-3",
        scopeBrief: "A future performance track.",
        prerequisites: ["cpp"],
        visible: true,
        access: "coming-soon",
        canEnroll: false,
        href: null,
        reason: "Not published yet.",
      },
    ];
    render(<RoadmapView courses={[]} futureCatalog={awaitingCatalog} dashboard={{
      ...dashboard,
      next: null,
      courses: [],
      roadmap: {
        state: "awaiting_publication",
        selectedTrackIds: ["qt", "hpc"],
        unavailableTrackIds: ["qt", "hpc"],
        selectedTrackPreviews: [
          {
            id: "qt",
            title: "Qt Desktop",
            summary: "A future desktop extension.",
            moduleCount: 5,
            skillCount: 24,
            publicationReady: false,
            href: "/courses/qt",
          },
          {
            id: "hpc",
            title: "High-performance computing",
            summary: "A future performance track.",
            moduleCount: 4,
            skillCount: 19,
            publicationReady: false,
            href: null,
          },
        ],
      },
    }} />);
    expect(screen.getByRole("heading", { name: "Selected courses are awaiting publication" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Selected courses awaiting publication" })).not.toBeInTheDocument();
    const previews = screen.getByRole("region", { name: "Selected curriculum previews" });
    expect(previews).toHaveTextContent("Modules5");
    expect(previews).toHaveTextContent("Skills24");
    expect(screen.getAllByText("Awaiting human review")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Preview curriculum" })).toHaveAttribute("href", "/courses/qt");
    expect(screen.getByText("Curriculum preview unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Continue plan/i })).not.toBeInTheDocument();
  });

  it("falls back to selected course names when preview metadata is unavailable", () => {
    const awaitingCatalog: readonly CatalogTrackViewState[] = [{
      id: "qt",
      title: "Qt Desktop",
      release: "launch-3",
      scopeBrief: "A future desktop extension.",
      prerequisites: ["cpp"],
      visible: true,
      access: "coming-soon",
      canEnroll: false,
      href: null,
      reason: "Not published yet.",
    }];
    render(<RoadmapView courses={[]} futureCatalog={awaitingCatalog} dashboard={{
      ...dashboard,
      next: null,
      courses: [],
      roadmap: {
        state: "awaiting_publication",
        selectedTrackIds: ["qt"],
        unavailableTrackIds: ["qt"],
        selectedTrackPreviews: [],
      },
    }} />);

    const summary = screen.getByRole("complementary", { name: "Selected courses awaiting publication" });
    expect(summary).toHaveTextContent("1 selected course");
    expect(summary).toHaveTextContent("Qt Desktop");
    expect(screen.queryByRole("region", { name: "Selected curriculum previews" })).not.toBeInTheDocument();
  });

  it("offers roadmap recovery when selected published tracks lack a plan", () => {
    render(<RoadmapView courses={[]} dashboard={{
      ...dashboard,
      next: null,
      courses: [],
      roadmap: {
        state: "initialization_required",
        selectedTrackIds: ["python"],
        unavailableTrackIds: [],
        selectedTrackPreviews: [],
      },
    }} />);
    expect(screen.getByRole("heading", { name: "Your roadmap is ready to create" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create my roadmap" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Continue plan/i })).not.toBeInTheDocument();
  });

  it("offers a safe retry when authoritative roadmap status is unavailable", () => {
    render(<RoadmapView courses={[]} dashboard={{
      ...dashboard,
      next: null,
      courses: [],
      roadmap: { state: "unavailable", selectedTrackIds: [], unavailableTrackIds: [], selectedTrackPreviews: [] },
      degraded: true,
    }} />);
    expect(screen.getByRole("heading", { name: "Roadmap status is temporarily unavailable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Continue plan/i })).not.toBeInTheDocument();
  });

  it("keeps populated authoritative plans navigable and gates planned stages", () => {
    const plannedDashboard: AuthoritativeDashboardData = {
      ...dashboard,
      courses: dashboard.courses.map((item) => ({ ...item, status: "planned" })),
    };
    render(<RoadmapView courses={[course]} dashboard={plannedDashboard} />);
    expect(screen.getByRole("link", { name: /Continue plan/i })).toHaveAttribute(
      "href",
      "/courses/c/skills/c.arrays.bounds",
    );
    expect(screen.getByText("Locked by prerequisites")).toBeInTheDocument();
    expect(screen.queryByText("Your roadmap is ready to create")).not.toBeInTheDocument();
  });

  it("shows Coming Soon scope without a navigable empty course", () => {
    const futureCatalog: readonly CatalogTrackViewState[] = [{
      id: "qt",
      title: "Qt",
      release: "launch-3",
      scopeBrief: "A future Qt desktop-development extension after intermediate C++.",
      prerequisites: ["cpp"],
      visible: true,
      access: "coming-soon",
      canEnroll: false,
      href: null,
      reason: "Coming Soon: the scope brief is visible, but no learner content is published.",
    }];

    render(<RoadmapView courses={[course]} futureCatalog={futureCatalog} />);
    const heading = screen.getByRole("heading", { name: "Qt" });
    const card = heading.closest("article");
    expect(card).toHaveAttribute("data-access", "coming-soon");
    expect(card).toHaveTextContent("A future Qt desktop-development extension");
    expect(card).toHaveTextContent("Prerequisite: cpp");
    expect(card?.querySelector("a")).toBeNull();
  });

  it("uses persisted due reviews instead of the local preview list", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ state: "not_started", session: null }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    render(<ReviewQueue dashboard={{ ...dashboard, reviewsDueCount: 8 }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/learning/daily-review", { cache: "no-store" }));
    expect(screen.getByText("Array bounds")).toBeInTheDocument();
    expect(screen.getByText(/Delayed review/)).toBeInTheDocument();
    expect(screen.getByText("skills due").closest("article")).toHaveTextContent("8");
    expect(screen.queryByText("Mutability, aliases and copying")).not.toBeInTheDocument();
    fetchMock.mockRestore();
  });

  it("shows no fabricated review evidence without an authoritative dashboard", () => {
    render(<ReviewQueue />);
    expect(screen.getByRole("complementary", { name: "Review preview data" })).toHaveTextContent(
      "no sample reviews or fabricated learning statistics",
    );
    expect(screen.getByText("No review is due.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Nothing due.*return home/i })).toHaveAttribute("href", "/learn");
    expect(screen.queryByText("Mutability, aliases and copying")).not.toBeInTheDocument();
    expect(screen.queryByText("71%")).not.toBeInTheDocument();
    expect(screen.queryByText("83%")).not.toBeInTheDocument();
    expect(screen.queryByText("8 days")).not.toBeInTheDocument();
  });

  it("shows no synthetic cohort identities before privacy projections are implemented", () => {
    render(<CommunityUnavailable />);
    expect(screen.getByRole("heading", { name: "Community sharing is not enabled yet." })).toBeInTheDocument();
    expect(screen.queryByText(/Aarav|Meera|Shivam/)).not.toBeInTheDocument();
  });
});
