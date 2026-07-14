import path from "node:path";

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ContentRepository,
  type AtomicSkill,
  type AuthoredFallbackLessonBlueprint,
  type AuthoredLesson,
} from "@/lib/content";
import { CodeLab, LessonWorkspace } from "../lesson-workspace";

vi.mock("../self-hosted-monaco-editor", () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    <textarea aria-label="Mock code editor" value={value} onChange={(event) => onChange(event.target.value)} />,
}));

let blueprint: AuthoredFallbackLessonBlueprint;
let skill: AtomicSkill;
let authoredLesson: AuthoredLesson;

beforeAll(async () => {
  const repository = new ContentRepository({ contentRoot: path.resolve(process.cwd(), "content") });
  skill = (await repository.getSkill("pf.computing.program"))!;
  authoredLesson = (await repository.getAuthoredLesson(skill.id))!;
  blueprint = await repository.compileLessonBlueprint(skill.id);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseProps = () => ({
  blueprint,
  skill,
  courseTitle: "Programming Foundations",
  moduleTitle: "Programs and computers",
  previousHref: "/courses/programming-foundations/skills/previous",
  nextHref: "/courses/programming-foundations/skills/next",
});

describe("lesson workspace interactions", () => {
  it("switches an authored pilot between lesson, visualizer, and quest modes", async () => {
    const user = userEvent.setup();
    render(<LessonWorkspace {...baseProps()} authoredLesson={authoredLesson} />);

    expect(screen.getByText("Topic checkpoint · one reviewed MCQ")).toBeInTheDocument();
    expect(screen.getByText(/Only an independently human-reviewed question from the current publication/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start checkpoint" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show one hint" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "One reviewed MCQ for this topic" }))
      .queryByRole("button", { name: /help|hint/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Visualize/i }));
    expect(screen.getByText("Topic trace visualizer")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next visualizer step" }));
    expect(screen.getByText(/Step 2: Algorithm/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Play visualizer" }));
    expect(screen.getByRole("button", { name: "Pause visualizer" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restart visualizer" }));
    expect(screen.getByText(/Step 1: Problem/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Quest/i }));
    expect(screen.getByText("Restore the control panel")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Run action/i }));
    expect(screen.getByText(/at least one complete idea/i)).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/reasoning or code fragment/i), "The output changes from unknown to 91.");
    await user.click(screen.getByRole("button", { name: /Run action/i }));
    expect(screen.getByText(/Evidence captured/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Use a hint/i }));
    expect(screen.getByText(/before-and-after state/i)).toBeInTheDocument();
  });

  it("implements the keyboard tab pattern for learning modes", async () => {
    const user = userEvent.setup();
    render(<LessonWorkspace {...baseProps()} authoredLesson={authoredLesson} />);

    const lesson = screen.getByRole("tab", { name: "Lesson" });
    lesson.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Practice" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Practice" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Practice" })).toBeInTheDocument();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Quest" })).toHaveFocus();
  });

  it("sends valid idempotent Codestead requests and keeps later messages in the same thread", async () => {
    const user = userEvent.setup();
    const threadId = "b3000000-0000-4000-8000-000000000001";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          callId: "call-1",
          content: "Start by naming the method separately from its source.",
          threadId,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          callId: "call-2",
          content: "A source file stores the instructions you write.",
          threadId,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    render(<LessonWorkspace {...baseProps()} authoredLesson={authoredLesson} />);

    await user.click(screen.getByRole("button", { name: /Ask Codestead/i }));
    expect(screen.getByRole("dialog", { name: "Codestead mentor" })).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Message Codestead" });
    await user.type(input, "Why are they different?{enter}");
    expect(await screen.findByText(/Start by naming the method/i)).toBeInTheDocument();
    await user.type(input, "What is source code?{enter}");
    expect(await screen.findByText(/source file stores/i)).toBeInTheDocument();

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, string>;
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, string>;
    expect(firstBody).toMatchObject({
      courseId: blueprint.courseId,
      skillId: skill.id,
      message: "Why are they different?",
    });
    expect(firstBody.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(firstBody).not.toHaveProperty("threadId");
    expect(secondBody).toMatchObject({
      courseId: blueprint.courseId,
      skillId: skill.id,
      message: "What is source code?",
      threadId,
    });
    expect(secondBody.requestId).not.toBe(firstBody.requestId);
    await user.click(screen.getByRole("button", { name: "Close tutor" }));
    expect(screen.queryByRole("textbox", { name: "Message Codestead" })).not.toBeInTheDocument();
  });

  it("introduces Patch as a ready learning pet and lets starter prompts prepare a message", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(<LessonWorkspace {...baseProps()} authoredLesson={authoredLesson} />);

    const trigger = screen.getByRole("button", { name: /Ask Codestead/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("codestead-mentor-pet")).toHaveAttribute("data-state", "ready");
    expect(screen.getByText("Patch is ready")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Explain with an analogy" }));
    expect(screen.getByRole("textbox", { name: "Message Codestead" }))
      .toHaveValue("Explain this skill with a simple everyday analogy.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows Patch thinking while a mentor response is in flight", async () => {
    const user = userEvent.setup();
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    vi.spyOn(globalThis, "fetch").mockReturnValueOnce(response);
    render(<LessonWorkspace {...baseProps()} authoredLesson={authoredLesson} />);

    await user.click(screen.getByRole("button", { name: /Ask Codestead/i }));
    await user.type(screen.getByRole("textbox", { name: "Message Codestead" }), "Help me understand{enter}");

    expect(screen.getByTestId("codestead-mentor-pet")).toHaveAttribute("data-state", "thinking");
    expect(screen.getByText("Patch is thinking")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    resolveResponse(new Response(JSON.stringify({
      callId: "call-patch",
      content: "Let us unpack it together.",
      threadId: "b3000000-0000-4000-8000-000000000003",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(await screen.findByText("Let us unpack it together.")).toBeInTheDocument();
    expect(screen.getByTestId("codestead-mentor-pet")).toHaveAttribute("data-state", "ready");
  });

  it("returns keyboard focus to the mentor trigger when Escape closes the cockpit", async () => {
    const user = userEvent.setup();
    render(<LessonWorkspace {...baseProps()} authoredLesson={authoredLesson} />);

    const trigger = screen.getByRole("button", { name: /Ask Codestead/i });
    await user.click(trigger);
    const composer = screen.getByRole("textbox", { name: "Message Codestead" });
    composer.focus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Codestead mentor" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("reuses the exact Codestead request when the first transport response is lost", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          content: "Let us recover with one small question.",
          threadId: "b3000000-0000-4000-8000-000000000002",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    render(<LessonWorkspace {...baseProps()} authoredLesson={authoredLesson} />);

    await user.click(screen.getByRole("button", { name: /Ask Codestead/i }));
    await user.type(screen.getByRole("textbox", { name: "Message Codestead" }), "Please explain again{enter}");

    expect(await screen.findByText(/recover with one small question/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(fetchMock.mock.calls[0]?.[1]?.body);
  });

  it("navigates deterministic fallback blocks when no authored lesson exists", async () => {
    const user = userEvent.setup();
    render(<LessonWorkspace {...baseProps()} />);

    expect(screen.getByRole("heading", { name: "Observable objective" })).toBeInTheDocument();
    expect(screen.getByText("Topic checkpoint · one reviewed MCQ")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start checkpoint" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Mark read & continue/i }));
    expect(screen.getByRole("heading", { name: "Plain-language mental model seed" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Previous/i }));
    expect(screen.getByRole("heading", { name: "Observable objective" })).toBeInTheDocument();
    const transferOutline = screen.getByRole("button", { name: /Transfer activity specification/i });
    await user.click(transferOutline);
    expect(screen.getByText(/surface-different context/i)).toBeInTheDocument();
  });

  it("runs and resets code through the server runner endpoint, including offline failure", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { clientRequestId: string };
        return new Response(
          JSON.stringify({ requestId: body.clientRequestId, status: "complete", stdout: "Ready\n" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      })
      .mockRejectedValueOnce(new Error("offline"));
    const { rerender } = render(<CodeLab courseId="javascript" skillId="js.basics" />);

    fireEvent.change(await screen.findByRole("textbox", { name: "Mock code editor" }), {
      target: { value: "console.log('Changed');" },
    });
    await user.click(screen.getByRole("button", { name: /Run/i }));
    expect(await screen.findByText("Ready", { exact: false, selector: "pre" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Reset/i }));
    await user.click(screen.getByRole("button", { name: "Reset JavaScript draft" }));
    expect((screen.getByRole("textbox", { name: "Mock code editor" }) as HTMLTextAreaElement).value)
      .toContain("Ready");

    rerender(<CodeLab courseId="javascript" skillId="js.basics.second" />);
    await user.click(screen.getByRole("button", { name: /Run/i }));
    await waitFor(() => expect(screen.getByText(/isolated runner could not be reached/i)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
