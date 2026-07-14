import path from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ContentRepository } from "@/lib/content";
import { AuthoredLessonCard, Visualizer } from "../lesson-workspace";

describe("authored lesson rendering", () => {
  it("renders topic-specific prose, provenance, examples, transfer, and text alternatives", async () => {
    const lesson = await new ContentRepository({ contentRoot: path.resolve(process.cwd(), "content") })
      .getAuthoredLesson("pf.computing.program");
    expect(lesson).toBeDefined();
    const { container } = render(<AuthoredLessonCard lesson={lesson!} />);

    expect(screen.getByRole("heading", { name: "Program, source code, and algorithm" })).toBeInTheDocument();
    expect(screen.getByText(/AI-assisted draft/i)).toBeInTheDocument();
    expect(screen.getByText(/No human editorial review yet/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Worked examples" })).toBeInTheDocument();
    expect(screen.getByText("Finding the largest score")).toBeInTheDocument();
    expect(screen.getByText("Choosing the shorter route")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Trace and text alternative" })).toBeInTheDocument();
    expect(screen.getByText("Far transfer")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Source provenance" })).toBeInTheDocument();
    const ids = Array.from(container.querySelectorAll<HTMLElement>("[id]"), (element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("drives the visualizer from the authored topic trace instead of a generic loop", async () => {
    const lesson = await new ContentRepository({ contentRoot: path.resolve(process.cwd(), "content") })
      .getAuthoredLesson("pf.computing.program");
    expect(lesson).toBeDefined();
    render(<Visualizer trace={lesson!.trace} />);
    expect(screen.getByText("Topic trace visualizer")).toBeInTheDocument();
    expect(screen.getByText(lesson!.trace.artifact[0]!)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Step 1: ${lesson!.trace.steps[0]!.focus}`, "i"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next visualizer step" }));
    expect(screen.getByText(new RegExp(`Step 2: ${lesson!.trace.steps[1]!.focus}`, "i"))).toBeInTheDocument();
    for (const [name, value] of Object.entries(lesson!.trace.steps[1]!.state)) {
      expect(screen.getByText(name)).toBeInTheDocument();
      expect(screen.getByText(value)).toBeInTheDocument();
    }
  });
});
