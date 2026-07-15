import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const durability = vi.hoisted(() => ({
  openBrowserOutbox: vi.fn(),
  purgeRecovery: vi.fn(),
  close: vi.fn(),
  withRepository: vi.fn(),
}));

vi.mock("@/lib/browser-durability/indexed-db", () => ({
  openBrowserOutbox: durability.openBrowserOutbox,
}));
vi.mock("@/lib/browser-durability/lifecycle", () => ({
  purgeBrowserRecoveryData: durability.purgeRecovery,
  withBrowserRecoveryRepository: durability.withRepository,
}));

import { BrowserDurabilityNamespaceProvider } from "@/lib/browser-durability/context";
import { DeviceSessionsPanel } from "../device-sessions-panel";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function unreadableDeniedResponse(status: 401 | 403, body: BodyInit | null = null) {
  const response = new Response(body, { status });
  const jsonSpy = vi.spyOn(response, "json");
  return { response, jsonSpy };
}

const activeSession = {
  id: "session-current",
  current: true,
  state: "active" as const,
  deviceLabel: "Chrome on Windows",
  createdAt: "2026-07-10T08:00:00.000Z",
  lastSeenAt: "2026-07-12T08:00:00.000Z",
  expiresAt: "2026-08-11T08:00:00.000Z",
  endedAt: null,
  endReason: null,
};

const endedSession = {
  id: "session-ended",
  current: false,
  state: "revoked" as const,
  deviceLabel: "Safari on macOS",
  createdAt: "2026-06-01T08:00:00.000Z",
  lastSeenAt: "2026-06-02T08:00:00.000Z",
  expiresAt: "2026-07-01T08:00:00.000Z",
  endedAt: "2026-06-02T09:00:00.000Z",
  endReason: "learner_logout",
};

describe("device session controls", () => {
  beforeEach(() => {
    durability.close.mockReset();
    durability.openBrowserOutbox.mockReset();
    durability.purgeRecovery.mockReset();
    durability.openBrowserOutbox.mockResolvedValue({ close: durability.close });
    durability.purgeRecovery.mockResolvedValue(undefined);
    durability.withRepository.mockImplementation(async (
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

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders active and ended sessions plus pending and decided revocation history", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      sessions: [activeSession, endedSession],
      revocationRequests: [
        {
          id: "request-pending",
          sessionId: activeSession.id,
          reason: "My laptop was lost while travelling.",
          status: "pending",
          decisionReason: null,
          createdAt: "2026-07-12T09:00:00.000Z",
          decidedAt: null,
        },
        {
          id: "request-denied",
          sessionId: endedSession.id,
          reason: "An older request reason.",
          status: "denied",
          decisionReason: "Identity could not be confirmed.",
          createdAt: "2026-07-11T09:00:00.000Z",
          decidedAt: "2026-07-11T10:00:00.000Z",
        },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<DeviceSessionsPanel />);

    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    expect(screen.getByText("Safari on macOS")).toBeInTheDocument();
    expect(screen.getByText("Identity could not be confirmed.", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("My laptop was lost while travelling.", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request pending" })).toBeDisabled();
    expect(screen.getByLabelText("Why should this device be revoked?")).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
  });

  it("uses safe defaults when the session endpoint omits optional collections", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({}));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<DeviceSessionsPanel />);

    expect(await screen.findByText("No session history is available.")).toBeInTheDocument();
    expect(screen.queryByText("Revocation request history")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("distinguishes a load failure from an empty history and recovers through retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: "Session storage is temporarily unavailable." }, { status: 503 }))
      .mockResolvedValueOnce(json({ sessions: [activeSession], revocationRequests: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<DeviceSessionsPanel />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Session storage is temporarily unavailable.")).toBeInTheDocument();
    expect(screen.queryByText("No session history is available.")).not.toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: "Retry loading sessions" }));

    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retains the last authoritative session list when a refresh fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ sessions: [activeSession], revocationRequests: [] }))
      .mockRejectedValueOnce(new TypeError("synthetic refresh failure"));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<DeviceSessionsPanel />);
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("synthetic refresh failure");
    expect(screen.getByText("Chrome on Windows")).toBeInTheDocument();
    expect(screen.queryByText("No session history is available.")).not.toBeInTheDocument();
  });

  it.each([
    [{ error: "Session access was denied." }, "Session access was denied."],
    [{}, "Sessions could not be loaded."],
  ])("surfaces an initial non-success response without exposing internals", async (body, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body, { status: 503 })));

    render(<DeviceSessionsPanel />);

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("fences the captured namespace on an initial 401 without consuming an empty body", async () => {
    const { response, jsonSpy } = unreadableDeniedResponse(401);
    durability.purgeRecovery.mockRejectedValueOnce(new Error("synthetic cleanup failure"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const navigate = vi.fn();

    render(
      <BrowserDurabilityNamespaceProvider namespace="namespace-load-denied">
        <DeviceSessionsPanel navigate={navigate} />
      </BrowserDurabilityNamespaceProvider>,
    );

    await waitFor(() => expect(durability.purgeRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "namespace-load-denied" }),
    ));
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(durability.purgeRecovery).toHaveBeenCalledTimes(1);
    expect(durability.close).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/login?reason=session-expired");
  });

  it("purges a late denial's old namespace without redirecting or latching the new generation", async () => {
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const newDenied = unreadableDeniedResponse(403, "<html>new denial</html>");
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return oldResponse;
      if (calls === 2) return json({ sessions: [activeSession], revocationRequests: [] });
      return newDenied.response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.fn();
    const view = render(
      <BrowserDurabilityNamespaceProvider namespace="namespace-old-generation">
        <DeviceSessionsPanel navigate={navigate} />
      </BrowserDurabilityNamespaceProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.rerender(
      <BrowserDurabilityNamespaceProvider namespace="namespace-new-generation">
        <DeviceSessionsPanel navigate={navigate} />
      </BrowserDurabilityNamespaceProvider>,
    );
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();

    await act(async () => resolveOld(new Response(null, { status: 401 })));
    await waitFor(() => expect(durability.purgeRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "namespace-old-generation" }),
    ));
    expect(navigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(durability.purgeRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "namespace-new-generation" }),
    ));
    expect(newDenied.jsonSpy).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/login?reason=session-expired");
  });

  it.each([
    [new Error("The session service is offline."), "The session service is offline."],
    ["opaque rejection", "Sessions could not be loaded."],
  ])("normalizes an initial request rejection", async (failure, message) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));

    render(<DeviceSessionsPanel />);

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("ignores an abort caused by unmounting instead of displaying a false error", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<DeviceSessionsPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.unmount();
  });

  it("ends other sessions, reports the count, and reloads authoritative state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ sessions: [activeSession], revocationRequests: [] }))
      .mockResolvedValueOnce(json({ revokedCount: 2 }))
      .mockResolvedValueOnce(json({ sessions: [activeSession], revocationRequests: [] }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ sessions: [activeSession], revocationRequests: [] }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();

    render(<DeviceSessionsPanel />);
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "End other sessions" }));
    expect(await screen.findByText("2 other session(s) ended.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/sessions", expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({ scope: "others" }),
    }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    await user.click(screen.getByRole("button", { name: "End other sessions" }));
    expect(await screen.findByText("0 other session(s) ended.")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(durability.purgeRecovery).not.toHaveBeenCalled();
  });

  it("fences the captured namespace on a DELETE 403 before consuming an HTML body", async () => {
    const denied = unreadableDeniedResponse(403, "<html>sign in</html>");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ sessions: [activeSession], revocationRequests: [] }))
      .mockResolvedValueOnce(denied.response);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(
      <BrowserDurabilityNamespaceProvider namespace="namespace-delete-denied">
        <DeviceSessionsPanel navigate={navigate} />
      </BrowserDurabilityNamespaceProvider>,
    );
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "End other sessions" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login?reason=session-expired"));
    expect(denied.jsonSpy).not.toHaveBeenCalled();
    expect(durability.purgeRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "namespace-delete-denied" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits for confirmed revoke-all and exact-namespace cleanup before navigation", async () => {
    let resolveDelete!: (response: Response) => void;
    let resolveCleanup!: () => void;
    const deleteResponse = new Promise<Response>((resolve) => { resolveDelete = resolve; });
    durability.purgeRecovery.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    }));
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "DELETE"
        ? deleteResponse
        : Promise.resolve(json({ sessions: [activeSession], revocationRequests: [] }))
    ));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(
      <BrowserDurabilityNamespaceProvider namespace="namespace-current">
        <DeviceSessionsPanel navigate={navigate} />
      </BrowserDurabilityNamespaceProvider>,
    );
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out everywhere" }));

    expect(durability.purgeRecovery).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => resolveDelete(json({ revokedCount: 1 })));
    await waitFor(() => expect(durability.purgeRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "namespace-current" }),
    ));
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => resolveCleanup());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login?reason=signed-out"));
    expect(durability.close).toHaveBeenCalledOnce();
  });

  it("preserves browser recovery when revoke-all is rejected", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ sessions: [activeSession], revocationRequests: [] }))
      .mockResolvedValueOnce(json({ error: "Could not end the current session." }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(
      <BrowserDurabilityNamespaceProvider namespace="namespace-current">
        <DeviceSessionsPanel navigate={navigate} />
      </BrowserDurabilityNamespaceProvider>,
    );
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out everywhere" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not end the current session.");
    expect(durability.purgeRecovery).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not let a stale revoke-all response purge a newly supplied namespace", async () => {
    let resolveDelete!: (response: Response) => void;
    const deleteResponse = new Promise<Response>((resolve) => { resolveDelete = resolve; });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "DELETE"
        ? deleteResponse
        : Promise.resolve(json({ sessions: [activeSession], revocationRequests: [] }))
    ));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const navigate = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <BrowserDurabilityNamespaceProvider namespace="namespace-old">
        <DeviceSessionsPanel navigate={navigate} />
      </BrowserDurabilityNamespaceProvider>,
    );
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    await act(async () => {
      view.rerender(
        <BrowserDurabilityNamespaceProvider namespace="namespace-new">
          <DeviceSessionsPanel navigate={navigate} />
        </BrowserDurabilityNamespaceProvider>,
      );
      resolveDelete(json({ revokedCount: 1 }));
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Sign out everywhere" })).toBeEnabled());
    expect(durability.purgeRecovery).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("requires confirmation before destructive session revocation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ sessions: [activeSession], revocationRequests: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();

    render(<DeviceSessionsPanel />);
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "End other sessions" }));
    await user.click(screen.getByRole("button", { name: "Sign out everywhere" }));

    expect(confirm).toHaveBeenNthCalledWith(1, "End every other signed-in session? Your current approved device will stay signed in.");
    expect(confirm).toHaveBeenNthCalledWith(2, "Sign out every session, including this approved device?");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Chrome on Windows")).toBeInTheDocument();
  });

  it("guards an in-flight session mutation against duplicate revocation clicks", async () => {
    let resolveDelete!: (response: Response) => void;
    const pendingDelete = new Promise<Response>((resolve) => { resolveDelete = resolve; });
    let deleteCalls = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleteCalls += 1;
        return pendingDelete;
      }
      return json({ sessions: [activeSession], revocationRequests: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<DeviceSessionsPanel />);
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    const endOthers = screen.getByRole("button", { name: "End other sessions" });
    fireEvent.click(endOthers);
    fireEvent.click(endOthers);

    await waitFor(() => expect(deleteCalls).toBe(1));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(endOthers).toBeDisabled();

    await act(async () => { resolveDelete(json({ revokedCount: 1 })); });
    expect(await screen.findByRole("status")).toHaveTextContent("1 other session(s) ended.");
    await waitFor(() => expect(endOthers).toBeEnabled());
  });

  it.each([
    [{ error: "The current session cannot be ended here." }, "The current session cannot be ended here."],
    [{}, "Sessions could not be ended."],
  ])("keeps controls usable when ending other sessions fails", async (body, message) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ sessions: [activeSession], revocationRequests: [] }))
      .mockResolvedValueOnce(json(body, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();

    render(<DeviceSessionsPanel />);
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "End other sessions" }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End other sessions" })).toBeEnabled();
    expect(screen.getByText("Chrome on Windows")).toBeInTheDocument();
  });

  it("submits a lost-device request for only the current active session and reloads pending state", async () => {
    const pendingRequest = {
      id: "request-new",
      sessionId: activeSession.id,
      reason: "This laptop was lost on the train.",
      status: "pending",
      decisionReason: null,
      createdAt: "2026-07-12T09:00:00.000Z",
      decidedAt: null,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ sessions: [activeSession], revocationRequests: [] }))
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json({ sessions: [activeSession], revocationRequests: [pendingRequest] }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<DeviceSessionsPanel />);
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Why should this device be revoked?"), pendingRequest.reason);
    await user.click(screen.getByRole("button", { name: "Request administrator revocation" }));

    expect(await screen.findByText(/administrator has been notified/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Why should this device be revoked?")).toHaveValue("");
    expect(await screen.findByRole("button", { name: "Request pending" })).toBeDisabled();
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/session-revocation-requests", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ sessionId: activeSession.id, reason: pendingRequest.reason }),
    }));
  });

  it("fences the captured namespace on a revocation POST 401 without awaiting a stalled body", async () => {
    const stalledJson = vi.fn(() => new Promise<never>(() => undefined));
    const denied = { ok: false, status: 401, json: stalledJson } as unknown as Response;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ sessions: [activeSession], revocationRequests: [] }))
      .mockResolvedValueOnce(denied);
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(
      <BrowserDurabilityNamespaceProvider namespace="namespace-request-denied">
        <DeviceSessionsPanel navigate={navigate} />
      </BrowserDurabilityNamespaceProvider>,
    );
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    await user.type(
      screen.getByLabelText("Why should this device be revoked?"),
      "This approved browser was lost during travel.",
    );

    await user.click(screen.getByRole("button", { name: "Request administrator revocation" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login?reason=session-expired"));
    expect(stalledJson).not.toHaveBeenCalled();
    expect(durability.purgeRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "namespace-request-denied" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ error: "Identity confirmation is already pending." }, "Identity confirmation is already pending."],
    [{}, "The revocation request could not be sent."],
  ])("reports a failed lost-device request and preserves the reason", async (body, message) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ sessions: [activeSession], revocationRequests: [] }))
      .mockResolvedValueOnce(json(body, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const reason = "This browser profile is no longer under my control.";

    render(<DeviceSessionsPanel />);
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Why should this device be revoked?"), reason);
    await user.click(screen.getByRole("button", { name: "Request administrator revocation" }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText("Why should this device be revoked?")).toHaveValue(reason);
    expect(screen.getByRole("button", { name: "Request administrator revocation" })).toBeEnabled();
  });

  it("restores usable controls and retains input after a rejected revocation request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ sessions: [activeSession], revocationRequests: [] }))
      .mockRejectedValueOnce(new TypeError("synthetic request failure"));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const reason = "This browser profile is no longer in my possession.";

    render(<DeviceSessionsPanel />);
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Why should this device be revoked?"), reason);
    await user.click(screen.getByRole("button", { name: "Request administrator revocation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("synthetic request failure");
    expect(screen.getByLabelText("Why should this device be revoked?")).toHaveValue(reason);
    expect(screen.getByRole("button", { name: "Request administrator revocation" })).toBeEnabled();
  });

  it("submits only one lost-device request while the first request is pending", async () => {
    let resolveRequest!: (response: Response) => void;
    const pendingRequest = new Promise<Response>((resolve) => { resolveRequest = resolve; });
    let postCalls = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        postCalls += 1;
        return pendingRequest;
      }
      return json({ sessions: [activeSession], revocationRequests: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<DeviceSessionsPanel />);
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    const reasonField = screen.getByLabelText("Why should this device be revoked?");
    await user.type(reasonField, "This approved browser was lost during travel.");
    const form = reasonField.closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(postCalls).toBe(1));
    expect(screen.getByRole("button", { name: /Sending request/ })).toBeDisabled();

    await act(async () => { resolveRequest(json({ ok: true })); });
    expect(await screen.findByRole("status")).toHaveTextContent(/administrator has been notified/i);
    await waitFor(() => expect(screen.getByRole("button", { name: "Request administrator revocation" })).toBeEnabled());
  });

  it("does not send a revocation request when no current active session exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ sessions: [endedSession], revocationRequests: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DeviceSessionsPanel />);
    expect(await screen.findByText("Safari on macOS")).toBeInTheDocument();
    expect(screen.getByLabelText("Why should this device be revoked?")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Request administrator revocation" })).toBeDisabled();
    expect(screen.getByText(/No current active approved device/i)).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
