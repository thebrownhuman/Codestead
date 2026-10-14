import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  required: vi.fn(), auth: vi.fn(), dashboard: vi.fn(), initialize: vi.fn(),
}));
vi.mock("@/lib/security/runtime-policy", () => ({ isApplicationAuthRequired: mocks.required }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.auth }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
vi.mock("@/lib/dashboard/learner", () => ({ loadAuthoritativeDashboard: mocks.dashboard, ensureLearnerRoadmapInitialized: mocks.initialize }));
vi.mock("@/components/dashboard/learner-dashboard", () => ({ LearnerDashboard: () => <div>Demo dashboard</div> }));
vi.mock("@/components/dashboard/authoritative-dashboard", () => ({ AuthoritativeDashboard: () => <div>Authenticated dashboard</div> }));
vi.mock("@/components/lesson/sql-practice-lesson", () => ({ SqlPracticeLesson: ({ lesson }: { lesson: { title: string } }) => <h1>{lesson.title}</h1> }));

import LearnPage from "../page";

beforeEach(() => { vi.clearAllMocks(); mocks.required.mockReturnValue(false); });

describe("SQL practice entry on learning home", () => {
  it("keeps demo dashboard and a full-document practice link", async () => {
    render(await LearnPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("Demo dashboard")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /SQL practice/ })).toHaveAttribute("href", "/learn?practice=sql");
    expect(mocks.auth).not.toHaveBeenCalled();
  });
  it("loads SQL content without loading dashboard data", async () => {
    render(await LearnPage({ searchParams: Promise.resolve({ practice: "sql" }) }));
    expect(screen.getByRole("heading")).toHaveTextContent("SQL basics: read, filter, join");
    expect(mocks.dashboard).not.toHaveBeenCalled();
  });
  it("retains authentication for SQL practice", async () => {
    mocks.required.mockReturnValue(true);
    mocks.auth.mockResolvedValue({ session: null });
    await expect(LearnPage({ searchParams: Promise.resolve({ practice: "sql" }) })).rejects.toThrow("redirect:/login");
  });
  it("keeps the authenticated dashboard path", async () => {
    mocks.required.mockReturnValue(true);
    mocks.auth.mockResolvedValue({ session: { user: { id: "learner", name: "Learner" } } });
    mocks.dashboard.mockResolvedValue({ initial: true });
    mocks.initialize.mockResolvedValue({ ready: true });
    render(await LearnPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("Authenticated dashboard")).toBeInTheDocument();
    expect(mocks.initialize).toHaveBeenCalledWith("learner", "Learner", { initial: true });
  });
});
