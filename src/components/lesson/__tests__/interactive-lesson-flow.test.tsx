import path from "node:path";

import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";

import { ContentRepository, type AuthoredLesson } from "@/lib/content";
import { InteractiveLessonFlow } from "../interactive-lesson-flow";

let lesson: AuthoredLesson;

beforeAll(async () => {
  const repository = new ContentRepository({ contentRoot: path.resolve(process.cwd(), "content") });
  lesson = (await repository.getAuthoredLesson("pf.computing.program"))!;
});

describe("interactive authored lesson flow", () => {
  it("uses unique landmark and heading ids with a stable sources label", () => {
    const { container } = render(<InteractiveLessonFlow lesson={lesson} />);
    const ids = Array.from(container.querySelectorAll<HTMLElement>("[id]"), (element) => element.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(screen.getByRole("region", { name: "Sources and review status" }))
      .toHaveTextContent(lesson.sources[0]!.sourceRef);
  });

  it("requires a prediction before revealing the first machine-state step", async () => {
    const user = userEvent.setup();
    render(<InteractiveLessonFlow lesson={lesson} />);

    const reveal = screen.getByRole("button", { name: "Reveal the first step" });
    expect(reveal).toBeDisabled();
    expect(screen.getByText(/scratchpad responses stay in this tab/i)).toBeInTheDocument();

    await user.type(
      screen.getByRole("textbox", { name: "Your prediction" }),
      "The computer will read the instructions in order.",
    );
    await user.click(reveal);

    expect(screen.getByRole("status")).toHaveTextContent(/prediction saved locally/i);
    expect(screen.getByText(new RegExp(`Step 1: ${lesson.trace.steps[0]!.focus}`, "i"))).toBeInTheDocument();
  });

  it("recovers a prediction entered before hydration and enables the reveal action", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<InteractiveLessonFlow lesson={lesson} />);
    const prediction = container.querySelector<HTMLTextAreaElement>("#predict textarea");
    expect(prediction).not.toBeNull();
    prediction!.value = "The named branch changes are applied to the checked-out branch.";
    document.body.append(container);

    const view = render(<InteractiveLessonFlow lesson={lesson} />, { container, hydrate: true });

    expect(screen.getByRole("button", { name: "Reveal the first step" })).toBeEnabled();
    view.unmount();
    container.remove();
  });

  it("steps through a worked example and keeps every explanation available to keyboard users", async () => {
    const user = userEvent.setup();
    render(<InteractiveLessonFlow lesson={lesson} />);

    expect(screen.getByText(`Step 1 of ${lesson.examples[0]!.walkthrough.length}`)).toBeInTheDocument();
    expect(screen.getByText(lesson.examples[0]!.walkthrough[0]!)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next worked step" }));
    expect(screen.getByText(`Step 2 of ${lesson.examples[0]!.walkthrough.length}`)).toBeInTheDocument();
    expect(screen.getByText(lesson.examples[0]!.walkthrough[1]!)).toBeInTheDocument();
  });

  it("gives immediate misconception feedback without awarding official evidence", async () => {
    const user = userEvent.setup();
    render(<InteractiveLessonFlow lesson={lesson} />);

    await user.click(screen.getByRole("button", { name: "Choose the precise explanation" }));
    expect(screen.getByText(/That is the safer mental model/i).closest("p"))
      .toHaveTextContent(lesson.misconceptions[0]!.correction);
    expect(screen.getByText(/practice-only check/i)).toBeInTheDocument();
  });

  it("fades support from a guided prompt to near and far transfer", async () => {
    const user = userEvent.setup();
    render(<InteractiveLessonFlow lesson={lesson} />);

    expect(screen.getByRole("heading", { name: /Rung 1.*Guided/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to near transfer" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Show one hint" }));
    expect(screen.getByText(lesson.practice.faded.scaffold[0]!)).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Your guided-practice answer" }),
      "I would apply the rule, trace the state, and check the result.",
    );
    await user.click(screen.getByRole("button", { name: "Continue to near transfer" }));
    expect(screen.getByRole("heading", { name: /Rung 2.*Similar problem/i })).toBeInTheDocument();
  });

  it("makes retrieval active before showing the authored recap", async () => {
    const user = userEvent.setup();
    render(<InteractiveLessonFlow lesson={lesson} />);

    const reveal = screen.getByRole("button", { name: "Compare with the recap" });
    expect(reveal).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Teach it back in your own words" }),
      "A program is a precise set of instructions that turns input into observable output.",
    );
    await user.click(reveal);
    expect(screen.getByText(lesson.recap.summary)).toBeInTheDocument();
    expect(screen.getByText(/This is reflection, not a correctness grade/i)).toBeInTheDocument();
  });
});
