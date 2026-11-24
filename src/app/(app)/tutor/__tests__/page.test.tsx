import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  required: vi.fn(), auth: vi.fn(), recommendNext: vi.fn(), getSkillLocation: vi.fn(),
}));
vi.mock("@/lib/security/runtime-policy", () => ({ isApplicationAuthRequired: mocks.required }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.auth }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
vi.mock("@/lib/learning-service/runtime", () => ({ learningService: { recommendNext: mocks.recommendNext } }));
vi.mock("@/lib/content", () => ({ createContentRepository: () => ({ getSkillLocation: mocks.getSkillLocation }) }));
vi.mock("@/components/product/tutor-view", () => ({
  TutorView: ({ lesson }: { lesson?: unknown }) => <pre>{JSON.stringify(lesson ?? null)}</pre>,
}));

import TutorPage from "../page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.required.mockReturnValue(true);
  mocks.auth.mockResolvedValue({ session: { user: { id: "learner", name: "Learner" } } });
});

describe("tutor page lesson context", () => {
  it("passes the learner's recommended skill and its course to the mentor chat", async () => {
    mocks.recommendNext.mockResolvedValue({ state: "ready", action: { skillId: "java.loops.for" } });
    mocks.getSkillLocation.mockResolvedValue({
      course: { id: "java" }, skill: { id: "java.loops.for", title: "Java for loops" },
    });
    render(await TutorPage());
    expect(mocks.recommendNext).toHaveBeenCalledWith("learner");
    expect(mocks.getSkillLocation).toHaveBeenCalledWith("java.loops.for");
    expect(screen.getByText(JSON.stringify({ courseId: "java", skillId: "java.loops.for", title: "Java for loops" }))).toBeInTheDocument();
  });

  it.each([
    ["no recommendation", () => mocks.recommendNext.mockResolvedValue({ state: "empty", action: null })],
    ["a failed recommendation", () => mocks.recommendNext.mockRejectedValue(new Error("private details"))],
    ["an unpublished skill", () => {
      mocks.recommendNext.mockResolvedValue({ state: "ready", action: { skillId: "missing" } });
      mocks.getSkillLocation.mockResolvedValue(undefined);
    }],
  ])("passes no lesson context for %s", async (_name, arrange) => {
    arrange();
    render(await TutorPage());
    expect(screen.getByText("null")).toBeInTheDocument();
  });

  it("requires a session", async () => {
    mocks.auth.mockResolvedValue({ session: null });
    await expect(TutorPage()).rejects.toThrow("redirect:/login");
  });

  it("skips the lookup when application auth is off", async () => {
    mocks.required.mockReturnValue(false);
    render(await TutorPage());
    expect(screen.getByText("null")).toBeInTheDocument();
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});
