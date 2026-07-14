import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExamLockdownOverlay } from "../exam-lockdown-overlay";

const mocks = vi.hoisted(() => ({ pathname: "/roadmap" }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));

function response(activeSessionId: string | null) {
  return new Response(JSON.stringify({
    exams: [{
      activeSessionId,
      courseTitle: "Python",
      moduleTitle: "Control flow",
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("active exam lockdown overlay", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.pathname = "/roadmap";
  });

  it("blocks non-exam app UI and focuses the only resume action", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("exam-1")));
    render(<><aside id="app-sidebar">Navigation</aside><div id="app-content-column">Lesson content</div><ExamLockdownOverlay /></>);
    const dialog = await screen.findByRole("alertdialog", { name: /Return to your exam workspace/i });
    expect(dialog).toHaveTextContent("Lessons, Codestead, practice games, general code runs, files, and project work");
    const resume = screen.getByRole("link", { name: /Resume timed exam/i });
    expect(resume).toHaveAttribute("href", "/exams/exam-1");
    await waitFor(() => expect(resume).toHaveFocus());
    expect(document.getElementById("app-sidebar")).toHaveAttribute("inert");
    expect(document.getElementById("app-content-column")).toHaveAttribute("aria-hidden", "true");
  });

  it("stays out of the way inside the active exam and when no exam is active", async () => {
    mocks.pathname = "/exams/exam-1";
    vi.stubGlobal("fetch", vi.fn(async () => response("exam-1")));
    const rendered = render(<ExamLockdownOverlay />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    rendered.unmount();
    mocks.pathname = "/roadmap";
    vi.stubGlobal("fetch", vi.fn(async () => response(null)));
    render(<ExamLockdownOverlay />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("does not expose internal errors if the catalog is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("database secret"); }));
    render(<ExamLockdownOverlay />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(document.body).not.toHaveTextContent("database secret");
  });
});
