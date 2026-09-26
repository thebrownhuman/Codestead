import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REVIEW_DIMENSIONS } from "@/lib/curriculum-publication/contracts";

import { humanize } from "../admin-utils";
import { AdminCurriculumPublication } from "../admin-curriculum-publication";

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const versionOne = "20000000-0000-4000-8000-000000000001";
const versionTwo = "20000000-0000-4000-8000-000000000002";
const artifactOne = "10000000-0000-4000-8000-000000000001";
const artifactTwo = "10000000-0000-4000-8000-000000000002";

const candidates = [
  { id: versionOne, courseId: "course-python", courseSlug: "python", title: "Python", version: "0.1.0", stage: "draft", publicationRevision: 1, contentHash: "a".repeat(64), artifactCount: 1, aiAssistedCount: 1, approvedCount: 0, unreviewedCount: 1, evidenceVersion: null, pointerVersion: null, isCurrent: false },
  { id: versionTwo, courseId: "course-js", courseSlug: "javascript", title: "JavaScript", version: "0.1.0", stage: "draft", publicationRevision: 1, contentHash: "b".repeat(64), artifactCount: 1, aiAssistedCount: 1, approvedCount: 0, unreviewedCount: 1, evidenceVersion: null, pointerVersion: null, isCurrent: false },
];

const queueItems = [
  { id: artifactOne, courseVersionId: versionOne, courseSlug: "python", courseTitle: "Python", courseVersion: "0.1.0", courseStage: "draft", artifactKey: "lesson.python.variables.v1", artifactType: "authored_lesson", sourcePath: "authored/lessons/python.variables.json", publicationStage: "draft", aiAssisted: true, reviewStatus: "unreviewed", rowVersion: 1 },
  { id: artifactTwo, courseVersionId: versionTwo, courseSlug: "javascript", courseTitle: "JavaScript", courseVersion: "0.1.0", courseStage: "draft", artifactKey: "lesson.javascript.variables.v1", artifactType: "authored_lesson", sourcePath: "authored/lessons/javascript.variables.json", publicationStage: "draft", aiAssisted: true, reviewStatus: "changes_requested", rowVersion: 2 },
];

function artifactFor(item: typeof queueItems[number]) {
  return {
    id: item.id,
    artifactKey: item.artifactKey,
    artifactType: item.artifactType,
    sourcePath: item.sourcePath,
    publicationStage: item.publicationStage,
    aiAssisted: item.aiAssisted,
    reviewStatus: item.reviewStatus,
    rowVersion: item.rowVersion,
  };
}

function detailFor(item: typeof queueItems[number]) {
  return {
    artifact: {
      ...artifactFor(item),
      courseVersionId: item.courseVersionId,
      content: { title: item.artifactKey },
      contentHash: "c".repeat(64),
      contentHashValid: true,
      expectedReviewItemIds: [item.artifactKey],
      embeddedHumanApproval: false,
    },
    timeline: [],
  };
}

describe("administrator curriculum editorial queue", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows cross-course outstanding counts and opens any staged artifact", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/curriculum") return json({
        candidates,
        reviewQueue: {
          total: 2,
          courseCount: 2,
          statusCounts: [
            { status: "unreviewed", count: 1 },
            { status: "changes_requested", count: 1 },
          ],
          courseCounts: [
            { courseVersionId: versionOne, courseSlug: "python", courseTitle: "Python", courseVersion: "0.1.0", count: 1 },
            { courseVersionId: versionTwo, courseSlug: "javascript", courseTitle: "JavaScript", courseVersion: "0.1.0", count: 1 },
          ],
          items: queueItems,
        },
      });
      if (url === `/api/admin/curriculum/versions/${versionOne}/artifacts`) return json({ artifacts: [artifactFor(queueItems[0]!)] });
      if (url === `/api/admin/curriculum/versions/${versionTwo}/artifacts`) return json({ artifacts: [artifactFor(queueItems[1]!)] });
      if (url === `/api/admin/curriculum/artifacts/${artifactOne}`) return json({ detail: detailFor(queueItems[0]!) });
      if (url === `/api/admin/curriculum/artifacts/${artifactTwo}`) return json({ detail: detailFor(queueItems[1]!) });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminCurriculumPublication />);

    expect(await screen.findByText("Editorial review queue")).toBeInTheDocument();
    expect(screen.getByText("2 outstanding across 2 courses")).toBeInTheDocument();
    const queue = screen.getByLabelText("Outstanding curriculum artifacts");
    expect(within(queue).getByRole("button", { name: /lesson\.python\.variables\.v1/i })).toBeInTheDocument();
    const second = within(queue).getByRole("button", { name: /lesson\.javascript\.variables\.v1/i });
    expect(second).toBeInTheDocument();
    expect(screen.getByText("Showing 1–2 of 2 matching artifacts (2 total). Page 1 of 1.")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Filter editorial queue by status"), "changes_requested");
    await waitFor(() => expect(within(queue).getAllByRole("button")).toHaveLength(1));
    expect(within(queue).queryByRole("button", { name: /lesson\.python\.variables\.v1/i })).not.toBeInTheDocument();
    expect(screen.getByText("Showing 1–1 of 1 matching artifacts (2 total). Page 1 of 1.")).toBeInTheDocument();

    await user.click(second);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/curriculum/artifacts/${artifactTwo}`,
      expect.objectContaining({ cache: "no-store" }),
    ));
    expect((await screen.findAllByText("lesson.javascript.variables.v1")).length).toBeGreaterThan(1);
  });

  it("searches and paginates a large queue with keyboard-accessible controls", async () => {
    const pagedItems = Array.from({ length: 31 }, (_, index) => ({
      ...queueItems[0]!,
      id: `artifact-page-${String(index + 1).padStart(2, "0")}`,
      artifactKey: `lesson.python.topic-${String(index + 1).padStart(2, "0")}.v1`,
      sourcePath: `authored/lessons/python.topic-${String(index + 1).padStart(2, "0")}.json`,
      rowVersion: index + 1,
    }));
    const firstItem = pagedItems[0]!;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/curriculum") return json({
        candidates: [candidates[0]],
        reviewQueue: {
          total: pagedItems.length,
          courseCount: 1,
          statusCounts: [{ status: "unreviewed", count: pagedItems.length }],
          courseCounts: [{ courseVersionId: versionOne, courseSlug: "python", courseTitle: "Python", courseVersion: "0.1.0", count: pagedItems.length }],
          items: pagedItems,
        },
      });
      if (url === `/api/admin/curriculum/versions/${versionOne}/artifacts`) return json({ artifacts: [artifactFor(firstItem)] });
      if (url === `/api/admin/curriculum/artifacts/${firstItem.id}`) return json({ detail: detailFor(firstItem) });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminCurriculumPublication />);

    const queue = await screen.findByLabelText("Outstanding curriculum artifacts");
    expect(within(queue).getAllByRole("button")).toHaveLength(25);
    expect(screen.getByText("Showing 1–25 of 31 matching artifacts (31 total). Page 1 of 2.")).toBeInTheDocument();

    const previous = screen.getByRole("button", { name: "Previous" });
    const next = screen.getByRole("button", { name: "Next" });
    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();
    next.focus();
    await user.keyboard("{Enter}");

    expect(within(queue).getAllByRole("button")).toHaveLength(6);
    expect(screen.getByText("Showing 26–31 of 31 matching artifacts (31 total). Page 2 of 2.")).toBeInTheDocument();
    expect(previous).toBeEnabled();
    expect(next).toBeDisabled();

    const search = screen.getByRole("searchbox", { name: "Search editorial queue" });
    await user.type(search, "topic-30");

    await waitFor(() => expect(within(queue).getAllByRole("button")).toHaveLength(1));
    expect(within(queue).getByRole("button", { name: /lesson\.python\.topic-30\.v1/i })).toBeInTheDocument();
    expect(screen.getByText("Showing 1–1 of 1 matching artifacts (31 total). Page 1 of 1.")).toBeInTheDocument();
    expect(previous).toBeDisabled();
    expect(next).toBeDisabled();

    await user.clear(search);
    await user.type(search, "does-not-exist");
    expect(await within(queue).findByText("No artifacts match these filters.")).toBeInTheDocument();
    expect(screen.getByText("Showing 0–0 of 0 matching artifacts (31 total). Page 1 of 1.")).toBeInTheDocument();
  });

  it("ignores an out-of-order detail response after the administrator selects another artifact", async () => {
    const slowFirstDetail = deferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/curriculum") return json({
        candidates,
        reviewQueue: {
          total: 2,
          courseCount: 2,
          statusCounts: [{ status: "unreviewed", count: 1 }, { status: "changes_requested", count: 1 }],
          courseCounts: [
            { courseVersionId: versionOne, courseSlug: "python", courseTitle: "Python", courseVersion: "0.1.0", count: 1 },
            { courseVersionId: versionTwo, courseSlug: "javascript", courseTitle: "JavaScript", courseVersion: "0.1.0", count: 1 },
          ],
          items: queueItems,
        },
      });
      if (url === `/api/admin/curriculum/versions/${versionOne}/artifacts`) return json({ artifacts: [artifactFor(queueItems[0]!)] });
      if (url === `/api/admin/curriculum/versions/${versionTwo}/artifacts`) return json({ artifacts: [artifactFor(queueItems[1]!)] });
      if (url === `/api/admin/curriculum/artifacts/${artifactOne}`) return slowFirstDetail.promise;
      if (url === `/api/admin/curriculum/artifacts/${artifactTwo}`) return json({ detail: detailFor(queueItems[1]!) });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminCurriculumPublication detailedReviewChecklist />);

    const queue = await screen.findByLabelText("Outstanding curriculum artifacts");
    await user.click(within(queue).getByRole("button", { name: /lesson\.javascript\.variables\.v1/i }));

    expect(await screen.findByRole("checkbox", { name: "lesson.javascript.variables.v1" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "lesson.python.variables.v1" })).not.toBeInTheDocument();

    slowFirstDetail.resolve(json({ detail: detailFor(queueItems[0]!) }));

    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: "lesson.javascript.variables.v1" })).toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: "lesson.python.variables.v1" })).not.toBeInTheDocument();
    });
  });

  it("runs the single-owner lifecycle: stage, approve, readiness, approve & publish, retire, and rollback", async () => {
    const versionDraft = "20000000-0000-4000-8000-000000000003";
    const versionCurrent = "20000000-0000-4000-8000-000000000004";
    const versionPrior = "20000000-0000-4000-8000-000000000005";
    const artifactDraft = "10000000-0000-4000-8000-000000000003";
    const draftItem = { ...queueItems[0]!, id: artifactDraft, courseVersionId: versionDraft, reviewStatus: "unreviewed" };
    const lifecycleCandidates = [
      { id: versionDraft, courseId: "course-lifecycle", courseSlug: "lifecycle", title: "Lifecycle", version: "0.1.0", stage: "draft", publicationRevision: 1, contentHash: "d".repeat(64), artifactCount: 1, aiAssistedCount: 0, approvedCount: 0, unreviewedCount: 1, evidenceVersion: null, pointerVersion: null, isCurrent: false },
      { id: versionCurrent, courseId: "course-lifecycle", courseSlug: "lifecycle", title: "Lifecycle", version: "0.2.0", stage: "beta", publicationRevision: 2, contentHash: "e".repeat(64), artifactCount: 1, aiAssistedCount: 0, approvedCount: 1, unreviewedCount: 0, evidenceVersion: 1, pointerVersion: 4, isCurrent: true },
      { id: versionPrior, courseId: "course-lifecycle", courseSlug: "lifecycle", title: "Lifecycle", version: "0.0.9", stage: "verified", publicationRevision: 1, contentHash: "f".repeat(64), artifactCount: 1, aiAssistedCount: 0, approvedCount: 1, unreviewedCount: 0, evidenceVersion: 1, pointerVersion: 3, isCurrent: false },
    ];
    let queue = { total: 1, courseCount: 1, statusCounts: [{ status: "unreviewed", count: 1 }], courseCounts: [{ courseVersionId: versionDraft, courseSlug: "lifecycle", courseTitle: "Lifecycle", courseVersion: "0.1.0", count: 1 }], items: [draftItem] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/admin/curriculum") return json({ candidates: lifecycleCandidates, reviewQueue: queue });
      if (url === `/api/admin/curriculum/versions/${versionDraft}/artifacts`) return json({ artifacts: [artifactFor(draftItem)] });
      if (url === `/api/admin/curriculum/versions/${versionCurrent}/artifacts`) return json({ artifacts: [] });
      if (url === `/api/admin/curriculum/versions/${versionPrior}/artifacts`) return json({ artifacts: [] });
      if (url === `/api/admin/curriculum/versions/${versionDraft}/owner-review`) {
        if (method === "POST") {
          queue = { ...queue, total: 0, statusCounts: [], items: [] };
          return json({ updated: 1, reviewedArtifactIds: [artifactDraft] });
        }
        return json({ reviewedArtifactIds: [] });
      }
      if (url === `/api/admin/curriculum/versions/${versionCurrent}/owner-review`) return json({ reviewedArtifactIds: [] });
      if (url === `/api/admin/curriculum/versions/${versionPrior}/owner-review`) return json({ reviewedArtifactIds: [] });
      if (url === `/api/admin/curriculum/artifacts/${artifactDraft}`) return json({ detail: detailFor(draftItem) });
      if (url === "/api/admin/curriculum/stage" && method === "POST") return json({ ok: true });
      if (url === `/api/admin/curriculum/versions/${versionDraft}/gate?target=verified`) {
        return json({ gate: { allowed: true, issues: [], warnings: [{ code: "RUNTIME_LESSON_MISSING", artifactKey: "python.variables", message: "Runtime lesson missing." }], reportHash: "hash-ok" } });
      }
      if (url === `/api/admin/curriculum/versions/${versionDraft}/publish` && method === "POST") return json({ ok: true });
      if (url === `/api/admin/curriculum/versions/${versionDraft}/approve` && method === "POST") {
        queue = { ...queue, total: 0, statusCounts: [], items: [] };
        return json({ report: { approvedCount: 1, alreadyApprovedCount: 0 } });
      }
      if (url === `/api/admin/curriculum/versions/${versionDraft}/retire` && method === "POST") return json({ ok: true });
      if (url === `/api/admin/curriculum/courses/course-lifecycle/rollback` && method === "POST") return json({ ok: true });
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminCurriculumPublication />);

    await screen.findByText("Editorial review queue");
    await user.click(screen.getByRole("button", { name: /Stage drafts/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/curriculum/stage",
      expect.objectContaining({ method: "POST" }),
    ));

    expect(screen.queryByText("Reviewed")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Approve all/i }));
    await waitFor(() => expect(screen.getByText("All artifacts in this version are approved.")).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText("Publication target"), "verified");
    await user.click(screen.getByRole("button", { name: "Check readiness" }));
    await waitFor(() => expect(screen.getByText("Ready to publish")).toBeInTheDocument());
    expect(screen.getByText(/1 warnings/)).toBeInTheDocument();
    expect(screen.getByText(/Skills: python\.variables/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Approve & publish verified/i }));
    await user.click(await screen.findByRole("button", { name: "Approve & publish" }));
    await waitFor(() => expect(screen.getByText("Approved and published as verified.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(`/api/admin/curriculum/versions/${versionDraft}/publish`, expect.objectContaining({ method: "POST" }));

    await user.click(screen.getByRole("button", { name: "Retire version" }));
    await waitFor(() => expect(screen.getByText(/retired; its immutable history/)).toBeInTheDocument());

    const currentCard = screen.getByRole("button", { name: /Lifecycle v0\.2\.0/i });
    await user.click(currentCard);
    await user.selectOptions(screen.getByLabelText("Publication target"), "beta");
    expect(await screen.findByText(/Already published as beta/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Rollback target"), versionPrior);
    await user.click(screen.getByRole("button", { name: "Rollback pointer" }));
    await waitFor(() => expect(screen.getByText(/Catalog pointer rolled back/)).toBeInTheDocument());
  });

  it("sends nothing when the owner cancels Approve & publish", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/curriculum") return json({
        candidates: [candidates[0]],
        reviewQueue: { total: 0, courseCount: 0, statusCounts: [], courseCounts: [], items: [] },
      });
      if (url === `/api/admin/curriculum/versions/${versionOne}/artifacts`) return json({ artifacts: [] });
      if (url === `/api/admin/curriculum/versions/${versionOne}/owner-review`) return json({ reviewedArtifactIds: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminCurriculumPublication />);
    await screen.findByText("Editorial review queue");
    await user.click(screen.getByRole("button", { name: /Approve & publish beta/i }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/approve"), expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/publish"), expect.anything());
  });

  it("surfaces the fresh-MFA prompt and a generic failure message", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/admin/curriculum") return json({
        candidates: [candidates[0]],
        reviewQueue: { total: 0, courseCount: 0, statusCounts: [], courseCounts: [], items: [] },
      });
      if (url === `/api/admin/curriculum/versions/${versionOne}/artifacts`) return json({ artifacts: [] });
      if (url === `/api/admin/curriculum/versions/${versionOne}/owner-review`) return json({ reviewedArtifactIds: [] });
      if (url === "/api/admin/curriculum/stage" && method === "POST") {
        return new Response(JSON.stringify({ error: "FRESH_MFA_REQUIRED" }), { status: 401, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const user = userEvent.setup();

    render(<AdminCurriculumPublication />);
    await screen.findByText("Editorial review queue");

    await user.click(screen.getByRole("button", { name: /Stage drafts/i }));

    expect(await screen.findByText(/Enter your six-digit authenticator code once/)).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("rejects a malformed authenticator code before sending the request", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/curriculum") return json({
        candidates: [candidates[0]],
        reviewQueue: { total: 0, courseCount: 0, statusCounts: [], courseCounts: [], items: [] },
      });
      if (url === `/api/admin/curriculum/versions/${versionOne}/artifacts`) return json({ artifacts: [] });
      if (url === `/api/admin/curriculum/versions/${versionOne}/owner-review`) return json({ reviewedArtifactIds: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminCurriculumPublication />);
    await screen.findByText("Editorial review queue");

    await user.type(screen.getByLabelText("Curriculum authenticator code"), "12ab");
    await user.click(screen.getByRole("button", { name: /Stage drafts/i }));

    expect(await screen.findByText("Enter the current six-digit authenticator code.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/admin/curriculum/stage", expect.anything());
  });

  it("submits the detailed seven-dimension review when the checklist is enabled", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/admin/curriculum") return json({
        candidates,
        reviewQueue: {
          total: 1,
          courseCount: 1,
          statusCounts: [{ status: "unreviewed", count: 1 }],
          courseCounts: [{ courseVersionId: versionOne, courseSlug: "python", courseTitle: "Python", courseVersion: "0.1.0", count: 1 }],
          items: [queueItems[0]!],
        },
      });
      if (url === `/api/admin/curriculum/versions/${versionOne}/artifacts`) return json({ artifacts: [artifactFor(queueItems[0]!)] });
      if (url === `/api/admin/curriculum/versions/${versionTwo}/artifacts`) return json({ artifacts: [] });
      if (url === `/api/admin/curriculum/versions/${versionOne}/owner-review`) return json({ reviewedArtifactIds: [] });
      if (url === `/api/admin/curriculum/versions/${versionTwo}/owner-review`) return json({ reviewedArtifactIds: [] });
      if (url === `/api/admin/curriculum/artifacts/${artifactOne}`) return json({ detail: detailFor(queueItems[0]!) });
      if (url === `/api/admin/curriculum/artifacts/${artifactOne}/review` && method === "POST") return json({ ok: true });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminCurriculumPublication detailedReviewChecklist />);

    await screen.findByText("Editorial review queue");
    await screen.findByText("Seven-dimension human checklist");
    for (const name of REVIEW_DIMENSIONS) {
      await user.click(screen.getByRole("checkbox", { name: humanize(name) }));
      await user.type(screen.getByLabelText(`${name} evidence reference`), "See commit abc123.");
      await user.type(screen.getByLabelText(`${name} review note`), "Reviewed carefully in detail.");
    }
    await user.click(screen.getByRole("checkbox", { name: "lesson.python.variables.v1" }));
    await user.selectOptions(screen.getByLabelText("Decision"), "approved");
    await user.click(screen.getByRole("button", { name: "Append review" }));

    await waitFor(() => expect(screen.getByText("Human review evidence appended without rewriting content.")).toBeInTheDocument());
  });

  it("shows the empty state when there are no staged candidates", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/curriculum") return json({
        candidates: [],
        reviewQueue: { total: 0, courseCount: 0, statusCounts: [], courseCounts: [], items: [] },
      });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminCurriculumPublication />);

    expect(await screen.findByText("No staged candidates.")).toBeInTheDocument();
  });
});
