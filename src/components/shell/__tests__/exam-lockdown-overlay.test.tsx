import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExamLockdownOverlay } from "../exam-lockdown-overlay";

const mocks = vi.hoisted(() => ({
  namespace: "n".repeat(43),
  openBrowserOutbox: vi.fn(),
  pathname: "/roadmap",
  purgeBrowserRecoveryData: vi.fn(),
  purgeDraftRecoveryData: vi.fn(),
  repository: { close: vi.fn() },
}));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/lib/browser-durability/context", () => ({
  useBrowserDurabilityNamespace: () => mocks.namespace,
}));
vi.mock("@/lib/browser-durability/indexed-db", () => ({
  openBrowserOutbox: mocks.openBrowserOutbox,
}));
vi.mock("@/lib/browser-durability/lifecycle", () => ({
  purgeBrowserRecoveryData: mocks.purgeBrowserRecoveryData,
  purgeDraftRecoveryData: mocks.purgeDraftRecoveryData,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

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
    mocks.openBrowserOutbox.mockReset();
    mocks.openBrowserOutbox.mockResolvedValue(mocks.repository);
    mocks.pathname = "/roadmap";
    mocks.purgeBrowserRecoveryData.mockReset();
    mocks.purgeBrowserRecoveryData.mockResolvedValue(undefined);
    mocks.purgeDraftRecoveryData.mockReset();
    mocks.purgeDraftRecoveryData.mockResolvedValue(undefined);
    mocks.repository.close.mockReset();
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
    expect(mocks.purgeDraftRecoveryData).toHaveBeenCalledWith({
      namespace: mocks.namespace,
      repository: mocks.repository,
      sessionStorage: window.sessionStorage,
    });
    expect(mocks.repository.close).toHaveBeenCalledOnce();
  });

  it("blocks learning immediately and withholds resume until draft-only cleanup finishes", async () => {
    const cleanup = deferred<void>();
    const pendingCommitLocks: boolean[] = [];
    const recordPendingCommit: ProfilerOnRenderCallback = () => {
      if (document.querySelector('[aria-labelledby="active-exam-cleanup-title"]')) {
        pendingCommitLocks.push(
          document.getElementById("app-content-column")?.hasAttribute("inert") ?? false,
        );
      }
    };
    mocks.purgeDraftRecoveryData.mockReturnValueOnce(cleanup.promise);
    vi.stubGlobal("fetch", vi.fn(async () => response("exam-1")));

    render(<><aside id="app-sidebar">Navigation</aside><div id="app-content-column">Lesson content</div><Profiler id="exam-lockdown" onRender={recordPendingCommit}><ExamLockdownOverlay /></Profiler></>);

    expect(await screen.findByRole("alertdialog", { name: /Preparing private exam recovery/i }))
      .toHaveTextContent(/ordinary learning remains locked/i);
    expect(screen.queryByRole("link", { name: /Resume timed exam/i })).not.toBeInTheDocument();
    expect(pendingCommitLocks).toEqual([true]);
    expect(document.getElementById("app-content-column")).toHaveAttribute("inert");

    cleanup.resolve();
    expect(await screen.findByRole("link", { name: /Resume timed exam/i }))
      .toHaveAttribute("href", "/exams/exam-1");
  });

  it("keeps learning blocked and retries draft cleanup safely after storage failure", async () => {
    mocks.purgeDraftRecoveryData
      .mockRejectedValueOnce(new Error("private answer text"))
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => response("exam-1")));

    render(<><div id="app-content-column">Lesson content</div><ExamLockdownOverlay /></>);

    const retry = await screen.findByRole("button", { name: /Retry browser storage cleanup/i });
    expect(document.body).not.toHaveTextContent("private answer text");
    expect(screen.queryByRole("link", { name: /Resume timed exam/i })).not.toBeInTheDocument();
    expect(document.getElementById("app-content-column")).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(retry);
    expect(await screen.findByRole("link", { name: /Resume timed exam/i })).toBeInTheDocument();
    expect(mocks.purgeDraftRecoveryData).toHaveBeenCalledTimes(2);
    expect(mocks.openBrowserOutbox).toHaveBeenCalledTimes(2);
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
    expect(mocks.purgeDraftRecoveryData).not.toHaveBeenCalled();
  });

  it("does not delete drafts when the catalog response is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    render(<ExamLockdownOverlay />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(mocks.openBrowserOutbox).not.toHaveBeenCalled();
    expect(mocks.purgeDraftRecoveryData).not.toHaveBeenCalled();
  });

  it("keeps a known closed-book lock when a later catalog refresh is unavailable", async () => {
    let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((handler, timeout) => {
      if (timeout === 15_000) poll = handler as () => void;
      return {} as ReturnType<typeof window.setInterval>;
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response("exam-1"))
      .mockResolvedValueOnce(new Response(null, { status: 503 })));

    render(<><div id="app-content-column">Lesson content</div><ExamLockdownOverlay /></>);
    expect(await screen.findByRole("link", { name: /Resume timed exam/i }))
      .toHaveAttribute("href", "/exams/exam-1");

    poll?.();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("link", { name: /Resume timed exam/i }))
      .toHaveAttribute("href", "/exams/exam-1");
    expect(document.getElementById("app-content-column")).toHaveAttribute("inert");
  });

  it.each([
    [401, () => new Response(null, { status: 401 })],
    [403, () => new Response("<html>Forbidden</html>", { status: 403 })],
  ] as const)("purges the exact namespace before redirecting after catalog auth denial %i", async (
    _status,
    denialResponse,
  ) => {
    const cleanup = deferred<void>();
    mocks.purgeBrowserRecoveryData.mockReturnValueOnce(cleanup.promise);
    vi.stubGlobal("fetch", vi.fn(async () => denialResponse()));
    const navigate = vi.fn();

    render(<><div id="app-content-column">Lesson content</div><ExamLockdownOverlay navigate={navigate} /></>);

    expect(await screen.findByRole("alertdialog", { name: /Session ended/i }))
      .toHaveTextContent(/private browser recovery/i);
    expect(navigate).not.toHaveBeenCalled();
    expect(mocks.purgeBrowserRecoveryData).toHaveBeenCalledWith({
      namespace: mocks.namespace,
      repository: mocks.repository,
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
    });

    cleanup.resolve();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login"));
    expect(mocks.repository.close).toHaveBeenCalledOnce();
  });
});
