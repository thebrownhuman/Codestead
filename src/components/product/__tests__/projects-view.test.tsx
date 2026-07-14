import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectsView } from "../projects-view";

const projectId = "10000000-0000-4000-8000-000000000001";
const reviewId = "10000000-0000-4000-8000-000000000002";
const requestId = "10000000-0000-4000-8000-000000000003";
const commitSha = "abcdef1234567890abcdef1234567890abcdef12";
const qualityAssessment = {
  schemaVersion: 1 as const,
  origin: "deterministic_static" as const,
  scoringMethod: "bounded_deductions_v1" as const,
  score: 88,
  categories: [
    { id: "likely-bug", label: "Likely bugs", score: 25, maximum: 25, findingCount: 0 },
    { id: "security", label: "Security", score: 25, maximum: 25, findingCount: 0 },
    { id: "testing", label: "Testing", score: 14, maximum: 20, findingCount: 1 },
    { id: "documentation", label: "Documentation", score: 9, maximum: 15, findingCount: 1 },
    { id: "maintainability", label: "Maintainability", score: 15, maximum: 15, findingCount: 0 },
  ],
  reviewedCommitSha: commitSha,
  filesReviewed: 7,
  findingsCapped: false,
  limitations: [
    "This is a bounded static text-pattern review, not proof that the project is correct or secure.",
    "The reviewer does not clone, install dependencies, build, execute code, run tests, or make network calls from repository code.",
  ],
};

function projectPayload(appeal: { id: string; status: string } | null = null) {
  return {
    projects: [{
      id: projectId,
      title: "Portfolio API",
      summary: "A small API with deterministic tests and documented trade-offs.",
      status: "reviewed",
      githubUrl: "https://github.com/example/project",
      updatedAt: "2026-07-12T10:00:00.000Z",
      prd: {
        track: "JavaScript + React",
        difficulty: "portfolio",
        problem: "Help a learner track deterministic portfolio evidence.",
        goals: ["Demonstrate the selected concepts independently."],
        nonGoals: ["The tutor will not write the full implementation."],
        milestones: [{ title: "Build", evidence: "One working path plus an automated check" }],
        acceptance: ["Normal and failure behavior are tested."],
      },
      effectiveReview: {
        sourceReviewId: reviewId,
        correctionId: null,
        commitSha,
        analyzerVersion: "static-review-v2",
        rubricVersion: "static-project-review-rubric-v2",
        provenance: { analysisMode: "deterministic_static", aiUsed: false },
        findings: [{
          origin: "deterministic_static",
          ruleId: "testing.missing-tests",
          category: "testing",
          message: "Add repeatable normal, boundary, and failure checks.",
        }],
        findingsHash: "a".repeat(64),
        revision: 1,
        updatedAt: "2026-07-12T09:00:00.000Z",
        qualityAssessment,
      },
      reviews: [{
        id: reviewId,
        commitSha,
        analyzerVersion: "static-review-v2",
        rubricVersion: "static-project-review-rubric-v2",
        analysisProvenance: { analysisMode: "deterministic_static", aiUsed: false },
        findings: [{ rule: "secret-scan" }],
        findingsHash: "a".repeat(64),
        status: "complete",
        createdAt: "2026-07-12T09:00:00.000Z",
        qualityAssessment,
        appeal,
        correction: null,
      }],
    }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("learner project-review appeals", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
  });

  it("submits the fixed category against the selected stored review and marks it open", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/projects" && !init?.method) {
        return new Response(JSON.stringify(projectPayload()), { status: 200 });
      }
      if (String(input) === `/api/projects/${projectId}/reviews/${reviewId}/appeal`) {
        return new Response(JSON.stringify({
          accepted: true,
          duplicate: false,
          appealId: "20000000-0000-4000-8000-000000000001",
          evidenceHash: "a".repeat(64),
        }), { status: 202 });
      }
      return new Response(JSON.stringify({ error: "Unexpected request" }), { status: 500 });
    }));

    render(<ProjectsView />);
    fireEvent.click(await screen.findByRole("button", { name: /Appeal review/ }));
    const reason = "The finding points to a documented fake token used only by tests.";
    fireEvent.change(screen.getByRole("textbox", { name: "Project review appeal reason" }), {
      target: { value: reason },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit appeal" }));

    expect(await screen.findByText(/original review remains unchanged/i)).toBeInTheDocument();
    expect(screen.getByText("Appeal open")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Appeal review/ })).not.toBeInTheDocument();
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/appeal"));
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        clientRequestId: requestId,
        category: "project_finding",
        reason,
      });
    });
  });

  it("presents an accessible deterministic score, category breakdown, limitations, finding guidance, and appeal path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(projectPayload()), { status: 200 })));
    render(<ProjectsView />);

    const review = await screen.findByRole("region", { name: "Deterministic code quality review for Portfolio API" });
    expect(review).toHaveTextContent("88/100");
    expect(review).toHaveTextContent("Pinned to commit abcdef123456");
    expect(screen.getByLabelText("Static quality score: 88 out of 100")).toHaveAttribute("value", "88");
    expect(screen.getByRole("list", { name: "Quality category breakdown" })).toHaveTextContent("Testing14/20");
    fireEvent.click(screen.getByText("Review findings and suggested improvements"));
    expect(review).toHaveTextContent("Add repeatable normal, boundary, and failure checks.");
    fireEvent.click(screen.getByText("What this score cannot prove"));
    expect(review).toHaveTextContent("not proof that the project is correct or secure");
    expect(screen.getByRole("button", { name: /Appeal review/ })).toBeInTheDocument();
  });

  it("does not offer a second appeal while one is actionable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(projectPayload({
      id: "20000000-0000-4000-8000-000000000001",
      status: "under_review",
    })), { status: 200 })));
    render(<ProjectsView />);
    expect(await screen.findByText("Appeal under_review")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Appeal review/ })).not.toBeInTheDocument();
  });

  it("retains an appeal reason and restores submission after a transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/projects" && !init?.method) {
        return new Response(JSON.stringify(projectPayload()), { status: 200 });
      }
      throw new TypeError("offline");
    }));

    render(<ProjectsView />);
    fireEvent.click(await screen.findByRole("button", { name: /Appeal review/ }));
    const reason = "The deterministic finding points to a documented fixture used only by tests.";
    fireEvent.change(screen.getByRole("textbox", { name: "Project review appeal reason" }), { target: { value: reason } });
    fireEvent.click(screen.getByRole("button", { name: "Submit appeal" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("still in the form");
    expect(screen.getByRole("textbox", { name: "Project review appeal reason" })).toHaveValue(reason);
    expect(screen.getByRole("button", { name: "Submit appeal" })).toBeEnabled();
  });

  it("opens the complete project brief without generating implementation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(projectPayload()), { status: 200 })));
    render(<ProjectsView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open PRD for Portfolio API" }));

    const dialog = screen.getByRole("dialog", { name: "Portfolio API" });
    expect(dialog).toHaveTextContent("Demonstrate the selected concepts independently.");
    expect(dialog).toHaveTextContent("One working path plus an automated check");
    expect(dialog).toHaveTextContent("Normal and failure behavior are tested.");
    expect(dialog).toHaveTextContent("will not generate the finished project");
    fireEvent.click(screen.getByRole("button", { name: "Close project PRD" }));
    expect(screen.queryByRole("dialog", { name: "Portfolio API" })).not.toBeInTheDocument();
  });

  it("shows a retryable error instead of an empty portfolio when loading fails", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify(projectPayload()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectsView />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Projects are temporarily unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Portfolio API")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains the brief and restores submission controls after a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ projects: [] }), { status: 200 });
      throw new TypeError("offline");
    }));

    render(<ProjectsView />);
    fireEvent.click(await screen.findByRole("button", { name: "Create your first brief" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Project title" }), { target: { value: "Resilient CLI" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Problem to solve" }), { target: { value: "Help learners keep a reliable local inventory of their practice tasks." } });
    fireEvent.click(screen.getByRole("button", { name: "Create PRD and milestones" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("still in the form");
    expect(screen.getByRole("textbox", { name: "Project title" })).toHaveValue("Resilient CLI");
    expect(screen.getByRole("button", { name: "Create PRD and milestones" })).toBeEnabled();
  });

  it("guards project creation synchronously against duplicate submissions", async () => {
    const pendingCreate = deferred<Response>();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ projects: [] }), { status: 200 });
      return pendingCreate.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectsView />);
    fireEvent.click(await screen.findByRole("button", { name: "Create your first brief" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Project title" }), { target: { value: "Single brief" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Problem to solve" }), { target: { value: "Prevent accidental duplicate project briefs during a slow network request." } });
    const form = screen.getByRole("button", { name: "Create PRD and milestones" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    fireEvent.submit(form!);

    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
    pendingCreate.resolve(new Response(JSON.stringify({ project: projectPayload().projects[0] }), { status: 201 }));
    expect(await screen.findByText("Portfolio API")).toBeInTheDocument();
  });

  it("warns before discarding a changed project brief and restores focus when closed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ projects: [] }), { status: 200 })));
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<ProjectsView />);
    const trigger = await screen.findByRole("button", { name: "Create your first brief" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole("textbox", { name: "Project title" }), { target: { value: "Unfinished brief" } });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(confirm).toHaveBeenCalledWith("Discard this unfinished project brief?");
    expect(screen.getByRole("dialog", { name: "Shape a project brief" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Shape a project brief" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
