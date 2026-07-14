import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminPlanRevisionManager } from "../admin-plan-revision-manager";

const learnerId = "10000000-0000-4000-8000-000000000001";
const enrollmentId = "20000000-0000-4000-8000-000000000001";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

const plan = [
  { id: "variables", skillId: "python.variables", title: "Variables", position: 0, prerequisites: [] },
  { id: "loops", skillId: "python.loops", title: "Loops", position: 1, prerequisites: ["python.variables"] },
];

function revision(revisionNumber: number) {
  return {
    id: `${revisionNumber}0000000-0000-4000-8000-000000000001`,
    revision: revisionNumber,
    parentId: revisionNumber > 1 ? `${revisionNumber - 1}0000000-0000-4000-8000-000000000001` : null,
    source: revisionNumber === 1 ? "adaptive_initializer" : "admin",
    reason: revisionNumber === 1 ? "Initial placement plan." : "Mentor reordered practice.",
    policyVersion: "admin-plan-revision-2026-07-12.v1",
    createdBy: revisionNumber === 1 ? "learner-1" : "admin-1",
    itemCount: plan.length,
    createdAt: `2026-07-${10 + revisionNumber}T08:00:00.000Z`,
  };
}

function history(latestRevision = 2) {
  return {
    policyVersion: "admin-plan-revision-2026-07-12.v1",
    enrollments: [{
      enrollmentId,
      status: "active",
      implementationLanguage: "Python",
      courseSlug: "python",
      courseTitle: "Python",
      courseVersion: "1.0.0",
      latestRevision,
      revisions: latestRevision === 3 ? [revision(3), revision(2), revision(1)] : [revision(2), revision(1)],
    }],
  };
}

function detail(selectedRevision = 2, latestRevision = 2) {
  const selected = revision(selectedRevision);
  return {
    enrollment: {
      id: enrollmentId,
      courseTitle: "Python",
      courseVersion: "1.0.0",
      implementationLanguage: "Python",
    },
    latestRevision,
    selected: { ...selected, plan },
    comparisonToLatest: {
      diff: { added: [], removed: [], moved: [], changed: [] },
      impact: {
        canApply: true,
        prerequisiteViolations: [],
        downstreamAffected: [],
        overrideRequests: [],
        evidencePreserved: true,
        masteryMutation: false,
        prerequisiteBypass: false,
      },
    },
    history: latestRevision === 3 ? [revision(3), revision(2), revision(1)] : [revision(2), revision(1)],
  };
}

const allowedPreview = {
  diff: { added: [], removed: [], moved: [], changed: [{ id: "loops", title: "Loops" }] },
  impact: {
    canApply: true,
    prerequisiteViolations: [],
    downstreamAffected: [{ skillId: "python.functions", title: "Functions" }],
    overrideRequests: [],
    evidencePreserved: true,
    masteryMutation: false,
    prerequisiteBypass: false,
  },
};

describe("administrator plan revision manager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders current items and append-only history without mastery controls", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/plans")) return json(history());
      if (url.endsWith(`/plans/${enrollmentId}`)) return json(detail());
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPlanRevisionManager learnerId={learnerId} />);

    expect(await screen.findByText("Variables")).toBeInTheDocument();
    expect(screen.getByText("Loops")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Revision history" })).toBeInTheDocument();
    expect(screen.getByText(/Initial placement plan/i)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Record unlock request \(gates enforced\)/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /set mastery|award mastery/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/password|api.?key|ciphertext/i);
  });

  it("requires impact preview, then fresh MFA, before saving and notifying a new revision", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    let saved = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.endsWith("/plans")) return json(history(saved ? 3 : 2));
      if (url.endsWith(`/plans/${enrollmentId}`)) return json(detail(saved ? 3 : 2, saved ? 3 : 2));
      if (url.endsWith("/revisions")) {
        if (body?.previewOnly) return json({ preview: allowedPreview, expectedRevision: 2 });
        saved = true;
        return json({ revision: revision(3), preview: allowedPreview }, { status: 201 });
      }
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminPlanRevisionManager learnerId={learnerId} />);
    await screen.findByText("Variables");
    await user.selectOptions(screen.getByLabelText("Plan item"), "loops");
    await user.type(screen.getByLabelText("Operation note"), "Repeat trace practice before assessment.");
    await user.type(screen.getByLabelText("Recorded reason"), "Repeated loop boundary mistakes need remediation.");
    expect(screen.getByRole("button", { name: "Save new revision" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Preview diff and impact" }));
    expect(await screen.findByText(/Downstream affected: Functions/i)).toBeInTheDocument();
    expect(screen.getByText(/mastery is unchanged.*prerequisite bypass remains disabled/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save new revision" })).toBeEnabled();

    await user.type(screen.getByLabelText("Current six-digit authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: "Save new revision" }));
    expect(await screen.findByText(/new append-only plan revision was saved, audited, and sent/i)).toBeInTheDocument();

    const previewCall = calls.find((call) => call.url.endsWith("/revisions") && call.body?.previewOnly === true);
    const saveCall = calls.find((call) => call.url.endsWith("/revisions") && call.body?.previewOnly === false);
    const mfaCall = calls.find((call) => call.url === "/api/security/fresh-mfa");
    expect(previewCall?.body).toMatchObject({
      expectedRevision: 2,
      operations: [{ type: "assign_remediation", itemId: "loops" }],
    });
    expect(saveCall?.body).toMatchObject({ expectedRevision: 2, previewOnly: false });
    expect(calls.indexOf(mfaCall!)).toBeLessThan(calls.indexOf(saveCall!));
    expect(JSON.stringify(saveCall?.body)).not.toMatch(/mastery|evidence|password|api.?key/i);
  });

  it("shows prerequisite violations and keeps save disabled", async () => {
    const blockedPreview = {
      ...allowedPreview,
      impact: {
        ...allowedPreview.impact,
        canApply: false,
        prerequisiteViolations: [{
          itemId: "loops",
          itemTitle: "Loops",
          prerequisiteSkillId: "python.variables",
          kind: "missing",
        }],
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/plans")) return json(history());
      if (url.endsWith(`/plans/${enrollmentId}`)) return json(detail());
      if (url.endsWith("/revisions") && init?.method === "POST") return json({ preview: blockedPreview });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminPlanRevisionManager learnerId={learnerId} />);
    await screen.findByText("Variables");
    await user.selectOptions(screen.getByLabelText("Operation"), "remove");
    await user.selectOptions(screen.getByLabelText("Plan item"), "variables");
    await user.type(screen.getByLabelText("Recorded reason"), "Testing prerequisite impact before removal.");
    await user.click(screen.getByRole("button", { name: "Preview diff and impact" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot be saved/i);
    expect(screen.getByText(/Loops: missing prerequisite python.variables/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save new revision" })).toBeDisabled();
  });

  it("reverts history by appending a new revision after fresh MFA and reason", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    let reverted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.endsWith("/plans")) return json(history(reverted ? 3 : 2));
      if (url.endsWith(`/plans/${enrollmentId}?revision=1`)) return json(detail(1, reverted ? 3 : 2));
      if (url.endsWith(`/plans/${enrollmentId}`)) return json(detail(reverted ? 3 : 2, reverted ? 3 : 2));
      if (url.endsWith("/revert")) { reverted = true; return json({ revision: revision(3) }, { status: 201 }); }
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminPlanRevisionManager learnerId={learnerId} />);
    await screen.findByText("Variables");
    await user.click(screen.getByRole("button", { name: "Review & revert" }));
    expect(await screen.findByRole("heading", { name: "Revert diff and downstream impact" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Recorded reason"), "Return to the initial mentor-approved sequence.");
    await user.type(screen.getByLabelText("Current six-digit authenticator code"), "654321");
    await user.click(screen.getByRole("button", { name: "Revert revision 1 as new" }));

    expect(await screen.findByText(/Revision 1 was restored as a new append-only revision/i)).toBeInTheDocument();
    const revertCall = calls.find((call) => call.url.endsWith("/revert"));
    expect(revertCall?.body).toMatchObject({ expectedRevision: 2, targetRevision: 1 });
    expect(String(revertCall?.body?.requestId)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(revertCall?.body)).not.toMatch(/mastery|password|api.?key/i);
  });

  it("surfaces history failures without rendering synthetic plan data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(
      { error: "Learning-plan history is temporarily unavailable." },
      { status: 503 },
    )));

    render(<AdminPlanRevisionManager learnerId={learnerId} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/temporarily unavailable/i);
    expect(screen.queryByText("Variables")).not.toBeInTheDocument();
  });

  it("renders a real empty state when the learner has no enrollment plan", async () => {
    const fetchMock = vi.fn(async () => json({
      policyVersion: "admin-plan-revision-2026-07-12.v1",
      enrollments: [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPlanRevisionManager learnerId={learnerId} />);

    expect(await screen.findByText("No persisted plans")).toBeInTheDocument();
    expect(screen.getByText(/appears after enrollment and placement planning/i)).toBeInTheDocument();
    expect(screen.getByText("no plan")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("surfaces a detail failure and uses the safe fallback for a non-error rejection", async () => {
    let detailRequested = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/plans")) return json(history());
      detailRequested = true;
      throw "unavailable";
    }));

    render(<AdminPlanRevisionManager learnerId={learnerId} />);

    await waitFor(() => expect(detailRequested).toBe(true));
    expect(await screen.findByRole("alert")).toHaveTextContent("Learning-plan detail could not be loaded.");
    expect(screen.queryByText("Variables")).not.toBeInTheDocument();
  });

  it("restores an item from an immutable historical revision", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    let sourceAttempts = 0;
    const historicalPlan = [
      ...plan,
      { id: "conditionals", skillId: "python.conditionals", title: "Conditionals", position: 2, prerequisites: ["python.variables"] },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.endsWith("/plans")) return json(history());
      if (url.endsWith(`/plans/${enrollmentId}?revision=1`)) {
        sourceAttempts += 1;
        if (sourceAttempts === 1) return json({ error: "Historical snapshot unavailable." }, { status: 503 });
        return json({ ...detail(1), selected: { ...detail(1).selected, plan: historicalPlan, itemCount: 3 } });
      }
      if (url.endsWith(`/plans/${enrollmentId}`)) return json(detail());
      if (url.endsWith("/revisions")) {
        return json({ preview: { ...allowedPreview, diff: { ...allowedPreview.diff, added: [{ id: "conditionals", title: "Conditionals" }] } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();

    render(<AdminPlanRevisionManager learnerId={learnerId} />);
    await screen.findByText("Variables");
    await user.selectOptions(screen.getByLabelText("Operation"), "add");
    await user.selectOptions(screen.getByLabelText("Source revision"), "1");
    expect(await screen.findByRole("alert")).toHaveTextContent("Historical snapshot unavailable.");
    await user.selectOptions(screen.getByLabelText("Source revision"), "");
    await user.selectOptions(screen.getByLabelText("Source revision"), "1");
    expect(await screen.findByRole("option", { name: "3. Conditionals" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Recorded reason"), "Restore conditional practice before loops.");
    await user.click(screen.getByRole("button", { name: "Preview diff and impact" }));
    expect(await screen.findByText(/Preview ready/i)).toBeInTheDocument();
    expect(calls.find((call) => call.url.endsWith("/revisions"))?.body).toMatchObject({
      operations: [{ type: "add", itemId: "conditionals", fromRevision: 1 }],
    });
  });

  it("validates a move before previewing its prerequisite impact", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/plans")) return json(history());
      if (url.endsWith(`/plans/${enrollmentId}`)) return json(detail());
      if (url.endsWith("/revisions")) {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ preview: allowedPreview });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();

    render(<AdminPlanRevisionManager learnerId={learnerId} />);
    await screen.findByText("Variables");
    await user.selectOptions(screen.getByLabelText("Operation"), "move");
    await user.type(screen.getByLabelText("Recorded reason"), "Move loops after more foundational practice.");
    await user.click(screen.getByRole("button", { name: "Preview diff and impact" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a plan item.");
    await user.selectOptions(screen.getByLabelText("Plan item"), "loops");
    await user.clear(screen.getByLabelText("New position"));
    await user.type(screen.getByLabelText("New position"), "0");
    await user.click(screen.getByRole("button", { name: "Preview diff and impact" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a valid destination position.");
    await user.clear(screen.getByLabelText("New position"));
    await user.type(screen.getByLabelText("New position"), "2");
    await user.click(screen.getByRole("button", { name: "Preview diff and impact" }));
    expect(await screen.findByText(/Preview ready/i)).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ operations: [{ type: "move", itemId: "loops", toPosition: 2 }] });
  });

  it("records an override directive but refuses save without valid fresh MFA", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.endsWith("/plans")) return json(history());
      if (url.endsWith(`/plans/${enrollmentId}`)) return json(detail());
      if (url.endsWith("/revisions")) return json({ preview: allowedPreview });
      if (url === "/api/security/fresh-mfa") return json({}, { status: 401 });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();

    render(<AdminPlanRevisionManager learnerId={learnerId} />);
    await screen.findByText("Variables");
    await user.selectOptions(screen.getByLabelText("Operation"), "override_defer");
    await user.selectOptions(screen.getByLabelText("Plan item"), "loops");
    await user.type(screen.getByLabelText("Recorded reason"), "Temporarily defer loops for focused review.");
    await user.type(screen.getByLabelText("Operation note"), "short");
    await user.click(screen.getByRole("button", { name: "Preview diff and impact" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/operation note of at least eight/i);
    await user.clear(screen.getByLabelText("Operation note"));
    await user.type(screen.getByLabelText("Operation note"), "Defer until variables review is complete.");
    await user.click(screen.getByRole("button", { name: "Preview diff and impact" }));
    expect(await screen.findByText(/Preview ready/i)).toBeInTheDocument();
    expect(calls.find((call) => call.url.endsWith("/revisions"))?.body).toMatchObject({
      operations: [{ type: "set_override", itemId: "loops", mode: "defer" }],
    });
    await user.type(screen.getByLabelText("Current six-digit authenticator code"), "123");
    await user.click(screen.getByRole("button", { name: "Save new revision" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/six-digit authenticator/i);
    await user.type(screen.getByLabelText("Current six-digit authenticator code"), "456");
    await user.click(screen.getByRole("button", { name: "Save new revision" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Fresh MFA verification failed.");
    expect(calls.filter((call) => call.url.endsWith("/revisions"))).toHaveLength(1);
  });

  it("shows historical prerequisite impact and validates revert authorization", async () => {
    const historical = detail(1);
    const impacted = {
      ...historical,
      comparisonToLatest: {
        ...historical.comparisonToLatest,
        impact: {
          ...historical.comparisonToLatest.impact,
          prerequisiteViolations: [{
            itemId: "loops",
            itemTitle: "Loops",
            prerequisiteSkillId: "python.variables",
            kind: "ordered_after_dependent",
          }],
          downstreamAffected: [{ skillId: "python.functions", title: "Functions" }],
        },
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/plans")) return json(history());
      if (url.endsWith(`/plans/${enrollmentId}?revision=1`)) return json(impacted);
      if (url.endsWith(`/plans/${enrollmentId}`)) return json(detail());
      if (url === "/api/security/fresh-mfa") return json({ error: "Authenticator rejected." }, { status: 401 });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();

    render(<AdminPlanRevisionManager learnerId={learnerId} />);
    await screen.findByText("Variables");
    await user.click(screen.getByRole("button", { name: "Review & revert" }));
    expect(await screen.findByText(/ordered after dependent prerequisite python.variables/i)).toBeInTheDocument();
    expect(screen.getByText("Downstream affected: Functions.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revert revision 1 as new" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/specific revert reason/i);
    await user.type(screen.getByLabelText("Recorded reason"), "Restore the earlier mentor-approved sequence.");
    await user.type(screen.getByLabelText("Current six-digit authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: "Revert revision 1 as new" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Authenticator rejected.");
  });
});
