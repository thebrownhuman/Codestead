import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DraftCacheNamespaceProvider } from "@/lib/drafts/browser-cache-context";
import { CodeLab } from "../lesson-workspace";

vi.mock("next/dynamic", () => ({
  default: () => function DeterministicEditor({
    language,
    options,
    value,
    onChange,
  }: {
    language: string;
    options?: { readOnly?: boolean };
    value: string;
    onChange: (value: string) => void;
  }) {
    return <textarea aria-label="Practice source code" data-editor-language={language} readOnly={options?.readOnly} value={value} onChange={(event) => onChange(event.target.value)} />;
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function storedValues() {
  return Array.from({ length: window.sessionStorage.length }, (_, index) => {
    const key = window.sessionStorage.key(index);
    return key ? window.sessionStorage.getItem(key) : null;
  });
}

describe("CodeLab non-authoritative runner client", () => {
  it.each([
    ["c", "#include <stdio.h>"],
    ["cpp", "#include <vector>"],
    ["java", "public class Main"],
    ["python", "# Implement and test the data structure here"],
  ] as const)("locks a DSA lesson Code Lab to authoritative runner slug %s", async (language, starterMarker) => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ requestId: body.clientRequestId, status: "accepted", stdout: "ok\n" });
    });
    render(<CodeLab courseId="dsa" dsaRunnerLanguage={language} skillId="dsa.arrays" />);

    expect(screen.queryByRole("combobox", { name: "Runner language" })).not.toBeInTheDocument();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    expect(editor).toHaveAttribute("data-editor-language", language);
    expect((editor as HTMLTextAreaElement).value).toContain(starterMarker);

    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      language,
      mode: "quick_run",
      skillId: "dsa.arrays",
    });
  });

  it("fails closed when a DSA runner language was not resolved", () => {
    render(<CodeLab courseId="dsa" skillId="dsa.arrays" />);

    expect(screen.getByRole("alert")).toHaveTextContent(/DSA language setup is required/i);
    expect(screen.getByRole("link", { name: /return to roadmap/i })).toHaveAttribute("href", "/roadmap");
    expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
  });

  it("does not run the starter before the authoritative draft finishes loading", async () => {
    let resolveDraft!: (response: Response) => void;
    const pendingDraft = new Promise<Response>((resolve) => { resolveDraft = resolve; });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(pendingDraft);
    render(
      <DraftCacheNamespaceProvider namespace="learner-session-namespace">
        <CodeLab courseId="python" skillId="python.print" />
      </DraftCacheNamespaceProvider>,
    );

    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(await screen.findByRole("textbox", { name: "Practice source code" })).toHaveAttribute("readonly");
    resolveDraft(json({ draft: null, cacheNamespace: "learner-session-namespace" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toBeEnabled());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["c", "C", "#include <stdio.h>\n\nint main(void) {\n    // Try the idea here\n    return 0;\n}\n"],
    ["cpp", "C++", "#include <iostream>\n\nint main() {\n    // Try the idea here\n    return 0;\n}\n"],
    ["java", "Java", "public class Main {\n    public static void main(String[] args) {\n        // Try the idea here\n    }\n}\n"],
    ["javascript", "JavaScript", "// Try the idea here\n\nconsole.log('Ready');\n"],
    ["python", "Python", "# Try the idea here\n\n"],
  ] as const)("binds the standalone %s starter, editor, reset, and runner request", async (language, label, starter) => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ requestId: body.clientRequestId, status: "accepted", stdout: "ok\n" });
    });
    render(<CodeLab allowLanguageSelection courseId="python" skillId="free-playground" />);

    const selector = screen.getByRole("combobox", { name: "Runner language" });
    expect(Array.from(selector.querySelectorAll("option"), (option) => option.textContent)).toEqual([
      "C",
      "C++",
      "Java",
      "JavaScript",
      "Python",
    ]);
    await user.selectOptions(selector, language);
    expect(selector).toHaveValue(language);
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(screen.getByText(new RegExp(`${escapedLabel} practice`, "i"))).toBeInTheDocument();

    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    expect(editor).toHaveAttribute("data-editor-language", language);
    expect(editor).toHaveValue(starter);
    const changedSource = `${starter}// learner change\n`;
    fireEvent.change(editor, { target: { value: changedSource } });
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      language,
      mode: "quick_run",
      skillId: "free-playground",
      source: changedSource,
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Reset" }));
    await user.click(screen.getByRole("button", { name: `Reset ${label} draft` }));
    expect(editor).toHaveValue(starter);
  });

  it("constructs a strict Python quick-run and exposes bounded queue progress", async () => {
    const user = userEvent.setup();
    let resolveResponse!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(pending);
    render(<CodeLab courseId="python" skillId="python.print" />);

    expect(screen.getByText(/PYTHON practice.*isolated NUC runner.*no mastery award/i)).toBeInTheDocument();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    fireEvent.change(editor, { target: { value: "print('bounded')\n" } });
    await user.click(screen.getByRole("button", { name: "Run" }));

    const runningButton = screen.getByRole("button", { name: /Running/i });
    expect(runningButton).toBeDisabled();
    expect(runningButton).toHaveAttribute("aria-busy", "true");
    expect(document.getElementById(runningButton.getAttribute("aria-controls")!)).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText(/waiting for one of two isolated runner slots.*queue is bounded/i)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Run status" })).toHaveTextContent("Waiting for an isolated runner slot.");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/code/run");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      language: "python",
      source: "print('bounded')\n",
      skillId: "python.print",
      mode: "quick_run",
      clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    const requestId = JSON.parse(String(init?.body)).clientRequestId as string;

    await act(async () => {
      resolveResponse(json({
        requestId,
        status: "accepted",
        stdout: "bounded\n",
        queue: { initialState: "queued", position: 2 },
        officialMasteryEvidence: false,
      }));
      await pending;
    });

    expect(await screen.findByText("bounded", { selector: "pre" })).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Run status" })).toHaveTextContent("Run completed. Standard output is ready.");
    expect(screen.getByText(/queue position 2/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
  });

  it("sends optional stdin, clears stale output when it changes, and resets it", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ requestId: body.clientRequestId, status: "accepted", stdout: "30\n" });
    });
    render(<CodeLab courseId="python" skillId="python.input" />);

    const stdin = screen.getByRole("textbox", { name: /Program input/i });
    await waitFor(() => expect(stdin).toBeEnabled());
    await user.type(stdin, "10{enter}20{enter}");
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("30", { selector: "pre" })).toBeInTheDocument();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      language: "python",
      stdin: "10\n20\n",
    });

    await user.type(stdin, "5");
    expect(screen.queryByText("30", { selector: "pre" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset" }));
    await user.click(screen.getByRole("button", { name: "Reset Python draft" }));
    expect(stdin).toHaveValue("");
  });

  it("keeps stdin per language through language switches and refresh-style remounts", async () => {
    const user = userEvent.setup();
    const view = render(
      <DraftCacheNamespaceProvider namespace="learner-session-stdin">
        <CodeLab allowLanguageSelection courseId="python" skillId="free-playground" />
      </DraftCacheNamespaceProvider>,
    );
    const selector = screen.getByRole("combobox", { name: "Runner language" });
    let stdin = screen.getByRole("textbox", { name: /Program input/i });
    await waitFor(() => expect(stdin).toBeEnabled());
    expect(screen.getByText(/browser tab storage keeps this Python input through refresh when available.*sign-out.*closing the tab clears it.*sent only when you run/i)).toBeInTheDocument();
    await user.type(stdin, "python input");

    await user.selectOptions(selector, "cpp");
    stdin = screen.getByRole("textbox", { name: /Program input/i });
    await waitFor(() => expect(stdin).toHaveValue(""));
    await user.type(stdin, "cpp input");
    await user.selectOptions(selector, "python");
    stdin = screen.getByRole("textbox", { name: /Program input/i });
    await waitFor(() => expect(stdin).toHaveValue("python input"));

    view.unmount();
    render(
      <DraftCacheNamespaceProvider namespace="learner-session-stdin">
        <CodeLab allowLanguageSelection courseId="python" skillId="free-playground" />
      </DraftCacheNamespaceProvider>,
    );
    stdin = screen.getByRole("textbox", { name: /Program input/i });
    await waitFor(() => expect(stdin).toHaveValue("python input"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Runner language" }), "cpp");
    await waitFor(() => expect(screen.getByRole("textbox", { name: /Program input/i })).toHaveValue("cpp input"));
  });

  it("removes the tab-scoped stdin copy when reset is confirmed", async () => {
    const user = userEvent.setup();
    const view = render(
      <DraftCacheNamespaceProvider namespace="learner-session-reset">
        <CodeLab courseId="python" skillId="python.stdin-reset" />
      </DraftCacheNamespaceProvider>,
    );
    const stdin = screen.getByRole("textbox", { name: /Program input/i });
    await waitFor(() => expect(stdin).toBeEnabled());
    await user.type(stdin, "private input");
    expect(Array.from({ length: window.sessionStorage.length }, (_, index) => window.sessionStorage.key(index)))
      .toContainEqual(expect.stringMatching(/:stdin$/));

    await user.click(screen.getByRole("button", { name: "Reset" }));
    await user.click(screen.getByRole("button", { name: "Reset Python draft" }));
    view.unmount();
    render(
      <DraftCacheNamespaceProvider namespace="learner-session-reset">
        <CodeLab courseId="python" skillId="python.stdin-reset" />
      </DraftCacheNamespaceProvider>,
    );
    await waitFor(() => expect(screen.getByRole("textbox", { name: /Program input/i })).toHaveValue(""));
    expect(Array.from({ length: window.sessionStorage.length }, (_, index) => window.sessionStorage.key(index)))
      .not.toContainEqual(expect.stringMatching(/:stdin$/));
  });

  it("turns an exhausted Python input traceback into actionable guidance without hiding stderr", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({
        requestId: body.clientRequestId,
        status: "runtime_error",
        stdout: "Enter first number: ",
        stderr: "Traceback (most recent call last):\n  File \"<workspace>/main.py\", line 1\nEOFError: EOF when reading a line\n",
      });
    });
    render(<CodeLab courseId="python" skillId="python.input" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("Program input needed")).toBeInTheDocument();
    expect(screen.getByText(/Program input is empty.*one value per line/i)).toBeInTheDocument();
    expect(screen.getByText(/EOFError: EOF when reading a line/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ask Codestead about this error/i })).toHaveAttribute("href", "/tutor");
    expect(screen.getByText(/not sent automatically/i)).toBeInTheDocument();
  });

  it("turns an exhausted Java Scanner traceback into actionable guidance without hiding stderr", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({
        requestId: body.clientRequestId,
        status: "runtime_error",
        stdout: "Enter first number: ",
        stderr: "Exception in thread \"main\" java.util.NoSuchElementException: No line found\n\tat java.base/java.util.Scanner.nextLine(Scanner.java:1660)\n\tat Main.main(Main.java:6)\n",
      });
    });
    render(<CodeLab courseId="java" skillId="java.input" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("Program input needed")).toBeInTheDocument();
    expect(screen.getByText(/Program input is empty.*one value per line/i)).toBeInTheDocument();
    expect(screen.getByText(/java\.util\.NoSuchElementException: No line found/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ask Codestead about this error/i })).toHaveAttribute("href", "/tutor");
    expect(screen.getByText(/not sent automatically/i)).toBeInTheDocument();
  });

  it("protects changed source and stdin with an accessible reset confirmation", async () => {
    const user = userEvent.setup();
    render(<CodeLab courseId="python" skillId="python.reset-safety" />);
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    const stdin = screen.getByRole("textbox", { name: /Program input/i });
    const reset = screen.getByRole("button", { name: "Reset" });
    fireEvent.change(editor, { target: { value: "print(input())\n" } });
    await user.type(stdin, "keep this input");

    await user.click(reset);
    const dialog = screen.getByRole("alertdialog", { name: "Reset Python draft?" });
    expect(dialog).toHaveAccessibleDescription(/replaces your saved source code.*clears program input.*cannot be undone/i);
    expect(screen.getByRole("button", { name: "Keep my work" })).toHaveFocus();
    expect(editor).toHaveValue("print(input())\n");
    expect(stdin).toHaveValue("keep this input");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(reset).toHaveFocus();
    expect(editor).toHaveValue("print(input())\n");
    expect(stdin).toHaveValue("keep this input");

    await user.click(reset);
    await user.click(screen.getByRole("button", { name: "Reset Python draft" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(editor).toHaveValue("# Try the idea here\n\n");
    expect(stdin).toHaveValue("");
  });

  it("freezes the selected language, editor, and reset while a run is pending", async () => {
    const user = userEvent.setup();
    let resolveResponse!: (response: Response) => void;
    let requestId = "";
    const pending = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requestId = String(JSON.parse(String(init?.body)).clientRequestId);
      return pending;
    });
    render(<CodeLab allowLanguageSelection courseId="python" skillId="free-playground" />);

    const selector = screen.getByRole("combobox", { name: "Runner language" });
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    const stdin = screen.getByRole("textbox", { name: /Program input/i });
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(selector).toBeDisabled();
    expect(editor).toHaveAttribute("readonly");
    expect(stdin).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Running/i })).toHaveAttribute("aria-busy", "true");
    fireEvent.change(editor, { target: { value: "must_not_replace_the_running_source" } });
    expect(editor).not.toHaveValue("must_not_replace_the_running_source");

    await act(async () => {
      resolveResponse(json({ requestId, status: "accepted", stdout: "done\n" }));
      await pending;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toBeEnabled());
    expect(selector).toBeEnabled();
    expect(editor).not.toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled();
  });

  it("shows stdout and stderr together and clears stale output after an edit", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({
        requestId: body.clientRequestId,
        status: "accepted",
        stdout: "normal output\n",
        stderr: "warning output\n",
      });
    });
    render(<CodeLab courseId="python" skillId="python.print" />);

    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("normal output", { selector: "pre" })).toBeInTheDocument();
    expect(screen.getByText("warning output", { selector: "pre" })).toBeInTheDocument();
    expect(screen.getByText("stdout")).toBeInTheDocument();
    expect(screen.getByText("stderr")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Run status" })).toHaveTextContent(
      "Run completed. Standard output is ready. Standard error is ready.",
    );
    expect(screen.getByRole("region", { name: "Program output" })).toHaveAttribute("tabindex", "0");

    fireEvent.change(await screen.findByRole("textbox", { name: "Practice source code" }), {
      target: { value: "print('changed')\n" },
    });
    expect(screen.queryByText("normal output", { selector: "pre" })).not.toBeInTheDocument();
    expect(screen.queryByText("warning output", { selector: "pre" })).not.toBeInTheDocument();
    expect(screen.getByText(/run your code to see compiler output/i)).toBeInTheDocument();
  });

  it("cannot turn a tampered response into a mastery-looking UI state", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      status: "mastered",
      stdout: "forged response body",
      officialMasteryEvidence: true,
      masteryAwarded: true,
      badge: "forged-master-badge",
      queue: { initialState: "mastered", position: 1 },
    }));
    render(<CodeLab courseId="python" skillId="python.print" />);

    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText(/response did not match.*output was ignored/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check run again" })).toBeEnabled();
    expect(screen.queryByText("forged response body")).not.toBeInTheDocument();
    expect(screen.queryByText("mastered", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/mastery awarded|forged-master-badge/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no mastery award/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot award mastery, badges, exam credit, or leaderboard points/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toMatchObject({
      officialMasteryEvidence: expect.anything(),
      masteryAwarded: expect.anything(),
    });
  });

  it("shows an explicit non-authoritative runner-configuration failure", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({
        requestId: body.clientRequestId,
        error: "The isolated runner is not configured. Your source was saved, but it was not executed.",
        officialMasteryEvidence: false,
      }, 503);
    });
    render(<CodeLab courseId="python" skillId="python.print" />);

    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText(/runner is not configured/i)).toBeInTheDocument();
    expect(screen.getByText("Run failed")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Run status" })).toHaveTextContent(
      "The run could not start. More details are available in Program output.",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/program finished with no output/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry run" })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot award mastery/i)).toBeInTheDocument();
  });

  it("renders the runner health preflight as an actionable offline state", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({
        requestId: body.clientRequestId,
        status: "offline",
        code: "RUNNER_OFFLINE",
        retryable: true,
        error: "The isolated runner is offline. Ask the administrator to start it, then retry.",
      }, 503);
    });
    render(<CodeLab courseId="python" skillId="python.print" />);

    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("Runner offline")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Run status" })).toHaveTextContent(
      "The runner could not be reached. More details are available in Program output.",
    );
    expect(screen.getByRole("button", { name: "Retry run" })).toBeEnabled();
  });

  it("ignores output bound to a different request id and retains the pending retry identity", async () => {
    const user = userEvent.setup();
    let sentRequestId = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sentRequestId = String(body.clientRequestId);
      return json({
        requestId: "20000000-0000-4000-8000-000000000002",
        status: "accepted",
        stdout: "stale output from another request\n",
        officialMasteryEvidence: false,
      });
    });
    render(<CodeLab courseId="python" skillId="python.print" />);

    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText(/response did not match.*output was ignored/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check run again" })).toBeEnabled();
    expect(screen.queryByText(/stale output from another request/i)).not.toBeInTheDocument();
    expect(storedValues()).toContain(sentRequestId);
  });

  it("keeps the browser draft and practice-only label when transport fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    render(<CodeLab courseId="python" skillId="python.print" />);
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    fireEvent.change(editor, {
      target: { value: "print('still here')\n" },
    });

    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText(/isolated runner could not be reached.*code is still saved/i)).toBeInTheDocument();
    expect(screen.getByText("Runner offline")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry run" })).toBeEnabled();
    expect(screen.getByText(/no mastery award/i)).toBeInTheDocument();
    expect(editor).toHaveValue("print('still here')\n");
  });

  it("ends a stalled request with an actionable timeout instead of loading forever", async () => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    let expireRequest!: () => void;
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, timeout?: number) => {
      if (timeout === 45_000 && typeof handler === "function") {
        expireRequest = () => handler();
        return 45_000;
      }
      return nativeSetTimeout(handler, timeout);
    }) as never);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => undefined));
    render(<CodeLab courseId="python" skillId="python.print" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: /Running/i })).toBeDisabled();
    await act(async () => {
      expireRequest();
      await Promise.resolve();
    });

    expect(screen.getByText("Runner timeout")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Run status" })).toHaveTextContent(
      "The runner took too long to respond. More details are available in Program output.",
    );
    expect(screen.getByRole("button", { name: "Check run again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
  });

  it("rejects an unreadable runner response and safely retries the same request", async () => {
    const user = userEvent.setup();
    const bodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response("not-json", { status: 502, headers: { "content-type": "text/plain" } });
      }
      return json({ requestId: body.clientRequestId, status: "accepted", stdout: "recovered\n" });
    });
    render(<CodeLab courseId="python" skillId="python.print" />);

    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Invalid response")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Run status" })).toHaveTextContent(
      "The runner returned an unreadable response. More details are available in Program output.",
    );
    await user.click(screen.getByRole("button", { name: "Check run again" }));

    expect(await screen.findByText("recovered", { selector: "pre" })).toBeInTheDocument();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.clientRequestId).toBe(bodies[0]?.clientRequestId);
  });

  it("reuses the exact persisted request id after an indeterminate response", async () => {
    const user = userEvent.setup();
    const bodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return json({
        requestId: body.clientRequestId,
        status: "infrastructure_error",
        code: "RUNNER_REQUEST_INDETERMINATE",
        retryable: true,
        indeterminate: true,
        error: "The runner outcome is not known yet. Retry this same request id.",
      }, 503);
    });
    render(<CodeLab courseId="python" skillId="python.print" />);

    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(await screen.findByText(/may have finished.*not confirmed/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check run again" }));
    await waitFor(() => expect(bodies).toHaveLength(2));

    expect(bodies[0]?.clientRequestId).toBe(bodies[1]?.clientRequestId);
    expect(storedValues()).toContain(bodies[0]?.clientRequestId);
  });

  it("restores an indeterminate request after reload and clears it after terminal truth", async () => {
    const user = userEvent.setup();
    const bodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return json({
          requestId: body.clientRequestId,
          status: "infrastructure_error",
          retryable: true,
          indeterminate: true,
          error: "The runner outcome is not known yet.",
        }, 503);
      }
      return json({
        requestId: body.clientRequestId,
        status: "accepted",
        stdout: "reconciled\n",
        officialMasteryEvidence: false,
      });
    });

    const firstMount = render(<CodeLab courseId="python" skillId="python.print" />);
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    const requestId = bodies[0]?.clientRequestId;
    expect(storedValues()).toContain(requestId);
    firstMount.unmount();

    render(<CodeLab courseId="python" skillId="python.print" />);
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]?.clientRequestId).toBe(requestId);
    expect(await screen.findByText("reconciled", { selector: "pre" })).toBeInTheDocument();
    expect(storedValues()).not.toContain(requestId);
  });

  it("allocates a new request id when the practice payload changes", async () => {
    const user = userEvent.setup();
    const bodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return json({
        requestId: body.clientRequestId,
        status: "infrastructure_error",
        retryable: true,
        indeterminate: true,
        error: "The runner outcome is not known yet.",
      }, 503);
    });
    render(<CodeLab courseId="python" skillId="python.print" />);

    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toBeEnabled());
    fireEvent.change(await screen.findByRole("textbox", { name: "Practice source code" }), {
      target: { value: "print('changed payload')\n" },
    });
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(bodies).toHaveLength(2));

    expect(bodies[1]?.source).toBe("print('changed payload')\n");
    expect(bodies[1]?.clientRequestId).not.toBe(bodies[0]?.clientRequestId);
  });
});
