import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  withRepository: vi.fn(),
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
  withBrowserRecoveryRepository: mocks.withRepository,
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
    mocks.namespace = "n".repeat(43);
    mocks.openBrowserOutbox.mockReset();
    mocks.openBrowserOutbox.mockResolvedValue(mocks.repository);
    mocks.pathname = "/roadmap";
    mocks.purgeBrowserRecoveryData.mockReset();
    mocks.purgeBrowserRecoveryData.mockResolvedValue(undefined);
    mocks.purgeDraftRecoveryData.mockReset();
    mocks.purgeDraftRecoveryData.mockResolvedValue(undefined);
    mocks.repository.close.mockReset();
    mocks.withRepository.mockImplementation(async (
      openRepository: () => Promise<{ close(): void }>,
      operation: (repository: { close(): void }) => Promise<unknown>,
    ) => {
      let unavailable = false;
      let repository: { close(): void };
      try {
        repository = await openRepository();
      } catch {
        unavailable = true;
        repository = { close: vi.fn() };
      }
      try {
        const result = await operation(repository);
        if (unavailable) throw new Error("Browser recovery IndexedDB is unavailable.");
        return result;
      } finally {
        if (!unavailable) repository.close();
      }
    });
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

  it("publishes draft-only entry when repository open fails and retries acquisition", async () => {
    mocks.openBrowserOutbox
      .mockRejectedValueOnce(new Error("IndexedDB open failed"))
      .mockResolvedValueOnce(mocks.repository);
    vi.stubGlobal("fetch", vi.fn(async () => response("exam-1")));

    render(<><div id="app-content-column">Lesson content</div><ExamLockdownOverlay /></>);

    const retry = await screen.findByRole("button", { name: /Retry browser storage cleanup/i });
    expect(mocks.purgeDraftRecoveryData).toHaveBeenCalledOnce();
    expect(mocks.purgeDraftRecoveryData).toHaveBeenCalledWith(expect.objectContaining({
      namespace: mocks.namespace,
      repository: expect.any(Object),
      sessionStorage: window.sessionStorage,
    }));
    expect(screen.queryByRole("link", { name: /Resume timed exam/i })).not.toBeInTheDocument();

    fireEvent.click(retry);
    expect(await screen.findByRole("link", { name: /Resume timed exam/i }))
      .toHaveAttribute("href", "/exams/exam-1");
    expect(mocks.openBrowserOutbox).toHaveBeenCalledTimes(2);
    expect(mocks.purgeDraftRecoveryData).toHaveBeenCalledTimes(2);
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

  it("publishes an auth boundary when repository open fails before redirecting", async () => {
    mocks.openBrowserOutbox.mockRejectedValueOnce(new Error("IndexedDB open failed"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    const navigate = vi.fn();

    render(<><div id="app-content-column">Lesson content</div><ExamLockdownOverlay navigate={navigate} /></>);

    expect(await screen.findByRole("alertdialog", { name: /Session ended/i }))
      .toBeInTheDocument();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login"));
    expect(mocks.purgeBrowserRecoveryData).toHaveBeenCalledOnce();
    expect(mocks.purgeBrowserRecoveryData).toHaveBeenCalledWith(expect.objectContaining({
      namespace: mocks.namespace,
      repository: expect.any(Object),
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
    }));
  });

  it("releases an old denial lock when the namespace changes without letting old cleanup redirect", async () => {
    const oldNamespace = "a".repeat(43);
    const newNamespace = "b".repeat(43);
    const oldCleanup = deferred<void>();
    let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((handler, timeout) => {
      if (timeout === 15_000) poll = handler as () => void;
      return {} as ReturnType<typeof window.setInterval>;
    });
    mocks.namespace = oldNamespace;
    mocks.purgeBrowserRecoveryData
      .mockReturnValueOnce(oldCleanup.promise)
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(new Response(null, { status: 403 })));
    const navigate = vi.fn();
    const view = render(<><div id="app-content-column">Lesson content</div><ExamLockdownOverlay navigate={navigate} /></>);

    expect(await screen.findByRole("alertdialog", { name: /Session ended/i }))
      .toBeInTheDocument();
    expect(document.getElementById("app-content-column")).toHaveAttribute("inert");

    mocks.namespace = newNamespace;
    view.rerender(<><div id="app-content-column">New session lesson</div><ExamLockdownOverlay navigate={navigate} /></>);

    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: /Session ended/i }))
      .not.toBeInTheDocument());
    expect(document.getElementById("app-content-column")).not.toHaveAttribute("inert");
    await act(async () => {
      oldCleanup.resolve();
      await oldCleanup.promise;
    });
    expect(navigate).not.toHaveBeenCalled();

    poll?.();
    expect(await screen.findByRole("alertdialog", { name: /Session ended/i }))
      .toBeInTheDocument();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login"));
    expect(mocks.purgeBrowserRecoveryData).toHaveBeenNthCalledWith(1, expect.objectContaining({
      namespace: oldNamespace,
    }));
    expect(mocks.purgeBrowserRecoveryData).toHaveBeenNthCalledWith(2, expect.objectContaining({
      namespace: newNamespace,
    }));
  });
});
