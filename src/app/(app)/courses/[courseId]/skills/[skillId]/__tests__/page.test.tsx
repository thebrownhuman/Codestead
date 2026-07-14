import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SkillPage from "../page";

const mocks = vi.hoisted(() => ({
  compileLessonBlueprint: vi.fn(),
  getAuthoredLesson: vi.fn(),
  getCourse: vi.fn(),
  getDsaImplementationLanguage: vi.fn(),
  getSkillLocation: vi.fn(),
  isApplicationAuthRequired: vi.fn(),
  lessonWorkspace: vi.fn(),
  listAssessmentBanks: vi.fn(),
  requireAuth: vi.fn(),
}));

vi.mock("@/components/lesson/lesson-workspace", () => ({
  DsaLanguageRequired: () => <div role="alert">DSA setup required</div>,
  LessonWorkspace: (props: Record<string, unknown>) => {
    mocks.lessonWorkspace(props);
    return <div data-testid="lesson-workspace" />;
  },
}));

vi.mock("@/lib/content", () => ({
  createContentRepository: () => ({
    compileLessonBlueprint: mocks.compileLessonBlueprint,
    getAuthoredLesson: mocks.getAuthoredLesson,
    getCourse: mocks.getCourse,
    getSkillLocation: mocks.getSkillLocation,
    listAssessmentBanks: mocks.listAssessmentBanks,
  }),
  toLearnerAssessmentBank: vi.fn(),
  toLearnerLessonPayload: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/learning-service/runtime", () => ({
  learningService: { getDsaImplementationLanguage: mocks.getDsaImplementationLanguage },
}));
vi.mock("@/lib/security/runtime-policy", () => ({
  isApplicationAuthRequired: mocks.isApplicationAuthRequired,
}));

const skill = { id: "dsa.arrays", title: "Arrays" };
const course = {
  id: "dsa",
  title: "Data Structures and Algorithms",
  modules: [{ skills: [skill] }],
};
const location = {
  course: { id: "dsa" },
  module: { title: "Arrays" },
  skill,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCourse.mockResolvedValue(course);
  mocks.getSkillLocation.mockResolvedValue(location);
  mocks.compileLessonBlueprint.mockResolvedValue({ courseId: "dsa" });
  mocks.getAuthoredLesson.mockResolvedValue(null);
  mocks.listAssessmentBanks.mockResolvedValue([]);
  mocks.requireAuth.mockResolvedValue({ session: { user: { id: "learner-1" } } });
  mocks.isApplicationAuthRequired.mockReturnValue(true);
});

describe("DSA skill page language binding", () => {
  it.each([
    ["C", "c"],
    ["C++", "cpp"],
    ["Java", "java"],
    ["Python", "python"],
  ] as const)("binds authenticated %s enrollment to %s lesson runner", async (language, runnerSlug) => {
    mocks.getDsaImplementationLanguage.mockResolvedValue(language);

    render(await SkillPage({ params: Promise.resolve({ courseId: "dsa", skillId: "dsa.arrays" }) }));

    expect(screen.getByTestId("lesson-workspace")).toBeInTheDocument();
    expect(mocks.compileLessonBlueprint).toHaveBeenCalledWith("dsa.arrays", {
      selectedLanguage: language,
    });
    expect(mocks.lessonWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      dsaRunnerLanguage: runnerSlug,
    }));
  });

  it("shows an explicit gate and does not compile a generic DSA lesson when language is missing", async () => {
    mocks.getDsaImplementationLanguage.mockResolvedValue(null);

    render(await SkillPage({ params: Promise.resolve({ courseId: "dsa", skillId: "dsa.arrays" }) }));

    expect(screen.getByRole("alert")).toHaveTextContent("DSA setup required");
    expect(mocks.compileLessonBlueprint).not.toHaveBeenCalled();
    expect(mocks.lessonWorkspace).not.toHaveBeenCalled();
  });

  it("uses C++ only for the explicit unauthenticated demo catalog", async () => {
    mocks.isApplicationAuthRequired.mockReturnValue(false);

    render(await SkillPage({ params: Promise.resolve({ courseId: "dsa", skillId: "dsa.arrays" }) }));

    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.getDsaImplementationLanguage).not.toHaveBeenCalled();
    expect(mocks.compileLessonBlueprint).toHaveBeenCalledWith("dsa.arrays", {
      selectedLanguage: "C++",
    });
    expect(mocks.lessonWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      dsaRunnerLanguage: "cpp",
    }));
  });
});
