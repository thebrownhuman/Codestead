import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { CourseManifest } from "@/lib/content";
import { CourseCatalog } from "../course-catalog";

function course(id: string, title: string): CourseManifest {
  return {
    $schema: "fixture",
    id,
    title,
    version: "1.0.0",
    status: "beta",
    release: "launch-1",
    summary: `${title} summary`,
    audience: { level: "beginner", assumed_knowledge: [], target_capability: "Learn independently" },
    scope: { includes: [], non_goals: [] },
    authoritative_sources: [],
    runtime: {
      kind: "conceptual",
      language: id,
      standard: "fixture",
      toolchain: [],
      execution_environment: "fixture",
      file_extensions: [],
      notes: [],
    },
    modules: [],
    exit_outcomes: [],
    coverage_summary: { total_skills: 0, required_skills: 0, elective_skills: 0, covered: 0, partial: 0, planned: 0 },
  };
}

const courses = [
  course("python", "Python"),
  course("react", "React"),
  course("dsa", "Data structures and algorithms"),
  course("git-tooling", "Git and tooling"),
];

describe("CourseCatalog filters", () => {
  it("filters immediately, exposes the selected state, and restores all tracks", async () => {
    const user = userEvent.setup();
    render(<CourseCatalog courses={courses} />);

    const all = screen.getByRole("button", { name: "All tracks" });
    const languages = screen.getByRole("button", { name: "Languages" });
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("4 tracks")).toBeInTheDocument();

    await user.click(languages);
    expect(languages).toHaveAttribute("aria-pressed", "true");
    expect(all).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("heading", { name: "Python" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "React" })).not.toBeInTheDocument();
    expect(screen.getByText("1 track")).toBeInTheDocument();

    await user.click(all);
    expect(screen.getByRole("heading", { name: "React" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Git and tooling" })).toBeInTheDocument();
  });
});
