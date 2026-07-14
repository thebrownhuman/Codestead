import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModuleProjectStudio } from "../module-project-studio";

const readyProject = {
  templateId: "template-variables",
  courseId: "python",
  courseTitle: "Python",
  courseVersion: "1.0.0",
  moduleId: "variables",
  title: "Build a tiny pantry tracker",
  stage: "verified",
  state: "ready",
  reason: "Independent mastery evidence is complete.",
  directAwardPolicy: "none",
  project: null,
  brief: {
    templateKey: "python:variables",
    publicationStatus: "verified",
    moduleTitle: "Variables",
    laymanScenario: "Think of a labelled kitchen jar: the label is the variable name and its contents are the value.",
    problem: "Track pantry items without losing their labels.",
    artifact: "A small command-line pantry tracker",
    learnerRole: "Builder",
    prerequisiteSkillIds: ["python.variables"],
    demonstratedOutcomes: ["Choose clear variable names"],
    milestones: [{ title: "Label the jars", purpose: "Create the state", evidence: "A clear source file" }],
    acceptanceChecks: [{ id: "normal", given: "two items", when: "the tracker runs", then: "both totals are correct" }],
    reflectionPrompts: ["Why did you choose those names?"],
    stretchGoals: ["Add one optional category"],
    editorialNotice: "Human reviewed",
    awardNotice: "This project prepares evidence but never awards mastery directly.",
  },
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ModuleProjectStudio", () => {
  it("turns a verified brief into small, layman-friendly build steps", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ projects: [readyProject] }) }));
    const user = userEvent.setup();

    render(<ModuleProjectStudio />);
    expect(await screen.findByRole("heading", { name: readyProject.title })).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /open brief/i }));
    expect(screen.getByText(readyProject.brief.laymanScenario)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Build it in small wins" })).toBeInTheDocument();
    expect(screen.getByText("Label the jars")).toBeInTheDocument();
    expect(screen.getByText("normal")).toBeInTheDocument();
    expect(screen.getByText(readyProject.brief.awardNotice)).toBeInTheDocument();
  });

  it("starts once with an idempotency key and changes the card to the existing project", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ projects: [readyProject] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { project: { id: "project-1", status: "draft", updatedAt: null } } }) });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "request-1" });
    const user = userEvent.setup();

    render(<ModuleProjectStudio />);
    await user.click(await screen.findByRole("button", { name: /start after mastery/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/module-projects", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ requestId: "request-1", templateId: readyProject.templateId }),
    }));
    expect(await screen.findByRole("link", { name: /open project/i })).toHaveAttribute("href", "/projects#project-1");
  });
});
