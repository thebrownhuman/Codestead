import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { BrowserOutboxRepository } from "@/lib/browser-durability/indexed-db";
import {
  draftOutboxScope,
  draftOutboxStorageKey,
  type DraftOutboxRecord,
} from "@/lib/browser-durability/types";
import { draftCacheKey, writeDraftCache, type CachedLearnerDraft } from "@/lib/drafts/browser-cache";
import { DraftCacheNamespaceProvider } from "@/lib/drafts/browser-cache-context";
import { DRAFT_CONTENT_MAX_BYTES } from "@/lib/drafts/types";
import { CodeLab } from "../lesson-workspace";

const { openBrowserOutboxMock } = vi.hoisted(() => ({
  openBrowserOutboxMock: vi.fn(),
}));

vi.mock("@/lib/browser-durability/indexed-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/browser-durability/indexed-db")>();
  return { ...actual, openBrowserOutbox: openBrowserOutboxMock };
});

vi.mock("next/dynamic", () => ({
  default: () => function DeterministicEditor({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) {
    return <textarea aria-label="Practice source code" value={value} onChange={(event) => onChange(event.target.value)} />;
  },
}));

const namespace = "opaque-learner-session-namespace";
const key = { kind: "code" as const, courseId: "python", skillId: "python.variables", language: "python" };
const serverDraft = {
  id: "20000000-0000-4000-8000-000000000001",
  ...key,
  language: "python",
  content: "server_answer = 42\n",
  rowVersion: 1,
  createdAt: "2026-07-12T10:00:00.000Z",
  updatedAt: "2026-07-12T10:01:00.000Z",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderLab(cacheNamespace = namespace) {
  return render(
    <DraftCacheNamespaceProvider namespace={cacheNamespace}>
      <CodeLab courseId="python" skillId="python.variables" />
    </DraftCacheNamespaceProvider>,
  );
}

function renderStandaloneLab(cacheNamespace = namespace) {
  return render(
    <DraftCacheNamespaceProvider namespace={cacheNamespace}>
      <CodeLab allowLanguageSelection courseId="python" skillId="free-playground" />
    </DraftCacheNamespaceProvider>,
  );
}

function cached(overrides: Partial<CachedLearnerDraft> = {}): CachedLearnerDraft {
  return {
    schemaVersion: 1,
    content: "local_answer = 41\n",
    language: "python",
    baseRowVersion: 0,
    requestId: "10000000-0000-4000-8000-000000000001",
    locallyUpdatedAt: "2026-07-12T10:00:00.000Z",
    dirty: true,
    ...overrides,
  };
}

function stalledDeniedResponse(status: 401 | 403 | 423) {
  const json = vi.fn(() => new Promise<never>(() => undefined));
  return {
    response: { ok: false, status, json } as unknown as Response,
    json,
  };
}

function outboxFor(
  draftNamespace: string,
  draftKey: typeof key,
  value: CachedLearnerDraft,
): DraftOutboxRecord {
  return {
    schemaVersion: 1,
    storageKey: draftOutboxStorageKey(draftNamespace, draftKey),
    namespace: draftNamespace,
    kind: "draft",
    scope: draftOutboxScope(draftKey),
    requestId: value.requestId,
    updatedAt: value.locallyUpdatedAt,
    payload: {
      key: draftKey,
      content: value.content,
      baseRevision: value.baseRowVersion,
    },
  };
}

function outbox(overrides: Partial<CachedLearnerDraft> = {}): DraftOutboxRecord {
  return outboxFor(namespace, key, cached(overrides));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function installRepository(overrides: Partial<Pick<
  BrowserOutboxRepository,
  "getDraft" | "putDraft" | "deleteDraftIfMutation" | "close"
>> = {}) {
  const repository = {
    getDraft: vi.fn(overrides.getDraft ?? (async () => null)),
    putDraft: vi.fn(overrides.putDraft ?? (async () => undefined)),
    deleteDraftIfMutation: vi.fn(overrides.deleteDraftIfMutation ?? (async () => true)),
    listExamAnswers: vi.fn(async () => []),
    putExamAnswer: vi.fn(async () => undefined),
    deleteExamAnswerIfMutation: vi.fn(async () => false),
    listExamEvents: vi.fn(async () => []),
    putExamEvent: vi.fn(async () => undefined),
    deleteExamEvent: vi.fn(async () => undefined),
    clearExamSession: vi.fn(async () => undefined),
    clearDrafts: vi.fn(async () => undefined),
    clearNamespace: vi.fn(async () => undefined),
    clearForeignNamespaces: vi.fn(async () => undefined),
    clearAll: vi.fn(async () => undefined),
    close: vi.fn(overrides.close ?? (() => undefined)),
  } satisfies BrowserOutboxRepository;
  openBrowserOutboxMock.mockResolvedValue(repository);
  return repository;
}

function successfulPut(content: string, rowVersion: number, replayed = false) {
  return json({
    draft: { ...serverDraft, content, rowVersion },
    committedRowVersion: rowVersion,
    replayed,
    cacheNamespace: namespace,
  });
}

function putBodies(fetchMock: MockInstance<typeof fetch>) {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

function draftNotice() {
  const notice = document.querySelector<HTMLElement>("[data-draft-status]");
  if (!notice) throw new Error("Draft status notice is missing.");
  return notice;
}

const staleNetworkOutcomes = [
  {
    finalStatus: "synced",
    label: "a retryable failure",
    sendsNewerMutation: true,
    settle(request: ReturnType<typeof deferred<Response>>) {
      request.reject(new Error("older response was lost"));
    },
  },
  {
    finalStatus: "conflict",
    label: "a version conflict",
    sendsNewerMutation: false,
    settle(request: ReturnType<typeof deferred<Response>>) {
      request.resolve(json({
        code: "DRAFT_VERSION_CONFLICT",
        current: { ...serverDraft, content: "newer_server = 9\n", rowVersion: 1 },
        cacheNamespace: namespace,
      }, 409));
    },
  },
  {
    finalStatus: "conflict",
    label: "an inconsistent acknowledgement",
    sendsNewerMutation: false,
    settle(request: ReturnType<typeof deferred<Response>>) {
      request.resolve(json({
        draft: { ...serverDraft, content: "different_receipt_result = 9\n", rowVersion: 2 },
        committedRowVersion: 1,
        cacheNamespace: namespace,
      }));
    },
  },
  {
    finalStatus: "scope-unavailable",
    label: "a scope denial",
    sendsNewerMutation: false,
    settle(request: ReturnType<typeof deferred<Response>>) {
      request.resolve(json({ code: "DRAFT_SCOPE_UNAVAILABLE" }, 404));
    },
  },
] as const;

describe("CodeLab authoritative draft synchronization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    openBrowserOutboxMock.mockReset();
    installRepository();
    window.sessionStorage.clear();
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    let id = 10;
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() =>
      `10000000-0000-4000-8000-${String(id++).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits locally before any PUT and exposes each truthful durability state", async () => {
    const localCommit = deferred<void>();
    installRepository({ putDraft: () => localCommit.promise });
    const serverAcknowledgement = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      return serverAcknowledgement.promise;
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));

    fireEvent.change(editor, { target: { value: "durable_after_commit = true\n" } });
    expect(screen.getByText("Saving on this browser...")).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    });
    expect(putBodies(fetchMock)).toHaveLength(0);

    await act(async () => localCommit.resolve());
    expect(await screen.findByText("Saved locally on this browser. Syncing to Codestead..."))
      .toBeInTheDocument();
    expect(putBodies(fetchMock)).toHaveLength(0);

    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1), { timeout: 2_000 });
    expect(screen.getByText(/syncing this draft to Codestead/i)).toBeInTheDocument();
    await act(async () => serverAcknowledgement.resolve(successfulPut(
      "durable_after_commit = true\n",
      1,
    )));
    expect(await screen.findByText("Saved to Codestead.")).toBeInTheDocument();
  });

  it("orders local puts so an older transaction cannot overwrite a newer edit", async () => {
    const firstCommit = deferred<void>();
    const secondCommit = deferred<void>();
    const repository = installRepository({
      putDraft: vi.fn()
        .mockImplementationOnce(() => firstCommit.promise)
        .mockImplementationOnce(() => secondCommit.promise),
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return successfulPut(String(body.content), 1);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
    fireEvent.change(editor, { target: { value: "first_local_write = 1\n" } });
    fireEvent.change(editor, { target: { value: "second_local_write = 2\n" } });

    await waitFor(() => expect(repository.putDraft).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Saving on this browser...")).toBeInTheDocument();
    expect(putBodies(fetchMock)).toHaveLength(0);

    await act(async () => firstCommit.resolve());
    await waitFor(() => expect(repository.putDraft).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Saving on this browser...")).toBeInTheDocument();
    expect(vi.mocked(repository.putDraft).mock.calls.map(([record]) => record.payload.content))
      .toEqual(["first_local_write = 1\n", "second_local_write = 2\n"]);

    await act(async () => secondCommit.resolve());
    await screen.findByText("Saved locally on this browser. Syncing to Codestead...");
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1), { timeout: 2_000 });
    expect(putBodies(fetchMock)[0]).toMatchObject({ content: "second_local_write = 2\n" });
  });

  it("fails closed on a local put error and retries the same record before sending", async () => {
    const retryCommit = deferred<void>();
    let localAttempts = 0;
    const repository = installRepository({
      putDraft: async () => {
        localAttempts += 1;
        if (localAttempts === 1) throw new Error("quota unavailable");
        return retryCommit.promise;
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      return successfulPut("keep_this_tab_open = true\n", 1);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
    fireEvent.change(editor, { target: { value: "keep_this_tab_open = true\n" } });

    expect(await screen.findByText(
      "Could not save on this browser. Keep this tab open and copy your work before leaving.",
    )).toBeInTheDocument();
    expect(putBodies(fetchMock)).toHaveLength(0);
    const firstRecord = vi.mocked(repository.putDraft).mock.calls[0]?.[0];

    await userEvent.click(screen.getByRole("button", { name: "Retry sync" }));
    expect(screen.getByText("Saving on this browser...")).toBeInTheDocument();
    const retriedRecord = vi.mocked(repository.putDraft).mock.calls[1]?.[0];
    expect(retriedRecord).toEqual(firstRecord);
    expect(putBodies(fetchMock)).toHaveLength(0);

    await act(async () => retryCommit.resolve());
    expect(await screen.findByText("Saved locally on this browser. Syncing to Codestead..."))
      .toBeInTheDocument();
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1), { timeout: 2_000 });
    expect(putBodies(fetchMock)[0]?.requestId).toBe(firstRecord?.requestId);
  });

  it("keeps an oversized paste copyable without claiming or attempting durability", async () => {
    const repository = installRepository();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      return successfulPut("must_not_send", 1);
    });
    const oversized = "x".repeat(DRAFT_CONTENT_MAX_BYTES + 1);

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));

    expect(() => {
      fireEvent.change(editor, { target: { value: oversized } });
    }).not.toThrow();

    expect(editor).toHaveValue(oversized);
    expect(await screen.findByText(
      "This draft exceeds the 131,072-byte UTF-8 save limit. Shorten it before retrying.",
    )).toBeInTheDocument();
    expect(draftNotice()).toHaveAttribute("data-draft-status", "local-save-error");
    expect(repository.putDraft).not.toHaveBeenCalled();
    expect(putBodies(fetchMock)).toHaveLength(0);
  });

  it("does not let an older local commit claim a later oversized paste is saved", async () => {
    const olderCommit = deferred<void>();
    const repository = installRepository({ putDraft: () => olderCommit.promise });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      return successfulPut("older_valid_edit = 1\n", 1);
    });
    const oversized = "x".repeat(DRAFT_CONTENT_MAX_BYTES + 1);

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
    fireEvent.change(editor, { target: { value: "older_valid_edit = 1\n" } });
    expect(draftNotice()).toHaveAttribute("data-draft-status", "saving-local");

    fireEvent.change(editor, { target: { value: oversized } });
    expect(draftNotice()).toHaveAttribute("data-draft-status", "local-save-error");
    await act(async () => olderCommit.resolve());
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    });

    expect(editor).toHaveValue(oversized);
    expect(draftNotice()).toHaveAttribute("data-draft-status", "local-save-error");
    expect(repository.putDraft).toHaveBeenCalledTimes(1);
    expect(putBodies(fetchMock)).toHaveLength(0);
  });

  it("reopens the same database after warm-cache loss and replays the original mutation", async () => {
    const factory = new FakeIDBFactory();
    const actual = await vi.importActual<typeof import("@/lib/browser-durability/indexed-db")>(
      "@/lib/browser-durability/indexed-db",
    );
    openBrowserOutboxMock.mockImplementation(() => actual.openBrowserOutbox(factory));
    const secondGet = deferred<Response>();
    const putRequests: Record<string, unknown>[] = [];
    let gets = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") {
        gets += 1;
        return gets === 1
          ? json({ draft: null, cacheNamespace: namespace })
          : secondGet.promise;
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      putRequests.push(body);
      return successfulPut(String(body.content), 1, true);
    });

    const firstMount = renderLab();
    let editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
    fireEvent.change(editor, { target: { value: "survives_browser_restart = true\n" } });
    await screen.findByText("Saved locally on this browser. Syncing to Codestead...");
    firstMount.unmount();
    expect(putRequests).toHaveLength(0);

    window.sessionStorage.clear();
    const secondMount = renderLab();
    editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue("survives_browser_restart = true\n"));
    expect(gets).toBe(2);
    expect(putRequests).toHaveLength(0);

    await act(async () => secondGet.resolve(json({ draft: null, cacheNamespace: namespace })));
    await waitFor(() => expect(putRequests).toHaveLength(1), { timeout: 2_000 });
    expect(putRequests[0]).toMatchObject({
      content: "survives_browser_restart = true\n",
      expectedRowVersion: 0,
      requestId: "10000000-0000-4000-8000-000000000010",
    });
    secondMount.unmount();
  });

  it("replays an identical body after response loss and conditionally removes it once", async () => {
    const repository = installRepository();
    let puts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      puts += 1;
      if (puts === 1) throw new Error("response lost");
      return successfulPut("exact_replay = true\n", 1, true);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
    fireEvent.change(editor, { target: { value: "exact_replay = true\n" } });
    expect(await screen.findByText(
      "Saved locally on this browser. Codestead will retry automatically.",
    )).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry sync" }));
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(2));
    expect(putBodies(fetchMock)[1]).toEqual(putBodies(fetchMock)[0]);
    await screen.findByText("Saved to Codestead.");
    expect(repository.deleteDraftIfMutation).toHaveBeenCalledTimes(1);
    expect(repository.deleteDraftIfMutation).toHaveBeenCalledWith(
      namespace,
      key,
      putBodies(fetchMock)[0]?.requestId,
    );
  });

  it("keeps an authoritative save truthful when cleanup rejects and safely replays it after reopen", async () => {
    let durableRecord: DraftOutboxRecord | null = null;
    const firstRepository = installRepository({
      putDraft: async (record) => { durableRecord = record; },
      deleteDraftIfMutation: async () => { throw new Error("cleanup transaction failed"); },
    });
    let currentServerDraft = { ...serverDraft, content: "cleanup_replay = true\n", rowVersion: 1 };
    let puts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") {
        return json({ draft: puts === 0 ? null : currentServerDraft, cacheNamespace: namespace });
      }
      puts += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      currentServerDraft = {
        ...currentServerDraft,
        content: String(body.content),
      };
      return successfulPut(String(body.content), 1, puts > 1);
    });

    const firstMount = renderLab();
    const firstEditor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
    fireEvent.change(firstEditor, { target: { value: "cleanup_replay = true\n" } });
    await screen.findByText("Saved to Codestead.");
    const firstBody = putBodies(fetchMock)[0];
    expect(firstRepository.deleteDraftIfMutation).toHaveBeenCalledWith(
      namespace,
      key,
      firstBody?.requestId,
    );
    expect(firstRepository.clearNamespace).not.toHaveBeenCalled();
    expect(firstRepository.clearAll).not.toHaveBeenCalled();
    expect(durableRecord).not.toBeNull();
    firstMount.unmount();

    const secondRepository = installRepository({
      getDraft: async () => durableRecord,
      deleteDraftIfMutation: async () => true,
    });
    renderLab();
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(2), { timeout: 2_000 });
    expect(putBodies(fetchMock)[1]).toEqual(firstBody);
    await screen.findByText("Saved to Codestead.");
    expect(secondRepository.deleteDraftIfMutation).toHaveBeenCalledWith(
      namespace,
      key,
      firstBody?.requestId,
    );
  });

  it.each(staleNetworkOutcomes)(
    "keeps a newer pending local write truthful when an older PUT settles with $label",
    async (outcome) => {
      const olderResponse = deferred<Response>();
      const newerCommit = deferred<void>();
      const repository = installRepository({
        putDraft: vi.fn()
          .mockResolvedValueOnce(undefined)
          .mockImplementationOnce(() => newerCommit.promise),
      });
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (putBodies(fetchMock).length === 1) return olderResponse.promise;
        return successfulPut(String(body.content), 1);
      });

      renderLab();
      const editor = await screen.findByRole("textbox", { name: "Practice source code" });
      await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
      fireEvent.change(editor, { target: { value: "older_network_write = 1\n" } });
      await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1), { timeout: 2_000 });

      fireEvent.change(editor, { target: { value: "newer_pending_write = 2\n" } });
      await waitFor(() => expect(repository.putDraft).toHaveBeenCalledTimes(2));
      expect(draftNotice()).toHaveAttribute("data-draft-status", "saving-local");

      await act(async () => {
        outcome.settle(olderResponse);
        await Promise.resolve();
      });
      expect(draftNotice()).toHaveAttribute("data-draft-status", "saving-local");
      expect(putBodies(fetchMock)).toHaveLength(1);

      await act(async () => newerCommit.resolve());
      await waitFor(() => expect(draftNotice()).toHaveAttribute(
        "data-draft-status",
        outcome.finalStatus,
      ), { timeout: 2_000 });
      if (outcome.sendsNewerMutation) {
        await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(2), { timeout: 2_000 });
        expect(putBodies(fetchMock)[1]).toMatchObject({ content: "newer_pending_write = 2\n" });
      } else {
        expect(putBodies(fetchMock)).toHaveLength(1);
      }
      expect(editor).toHaveValue("newer_pending_write = 2\n");
    },
  );

  it.each(staleNetworkOutcomes)(
    "keeps a newer failed local write retryable when an older PUT settles with $label",
    async (outcome) => {
      const olderResponse = deferred<Response>();
      const repository = installRepository({
        putDraft: vi.fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("newer local write failed"))
          .mockResolvedValue(undefined),
      });
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (putBodies(fetchMock).length === 1) return olderResponse.promise;
        return successfulPut(String(body.content), 1);
      });

      renderLab();
      const editor = await screen.findByRole("textbox", { name: "Practice source code" });
      await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
      fireEvent.change(editor, { target: { value: "older_network_write = 1\n" } });
      await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1), { timeout: 2_000 });

      fireEvent.change(editor, { target: { value: "newer_failed_write = 2\n" } });
      await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "local-save-error"));
      const failedRecord = vi.mocked(repository.putDraft).mock.calls[1]?.[0];

      await act(async () => {
        outcome.settle(olderResponse);
        await Promise.resolve();
      });
      expect(draftNotice()).toHaveAttribute("data-draft-status", "local-save-error");
      expect(putBodies(fetchMock)).toHaveLength(1);

      await userEvent.click(screen.getByRole("button", { name: "Retry sync" }));
      await waitFor(() => expect(repository.putDraft).toHaveBeenCalledTimes(3));
      expect(vi.mocked(repository.putDraft).mock.calls[2]?.[0]).toEqual(failedRecord);
      await waitFor(() => expect(draftNotice()).toHaveAttribute(
        "data-draft-status",
        outcome.finalStatus,
      ), { timeout: 2_000 });
      if (outcome.sendsNewerMutation) {
        await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(2), { timeout: 2_000 });
        expect(putBodies(fetchMock)[1]).toMatchObject({
          content: "newer_failed_write = 2\n",
          requestId: failedRecord?.requestId,
        });
      } else {
        expect(putBodies(fetchMock)).toHaveLength(1);
      }
      expect(editor).toHaveValue("newer_failed_write = 2\n");
    },
  );

  it("lets a newer committed edit supersede an older failed PUT", async () => {
    const olderResponse = deferred<Response>();
    const repository = installRepository();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (putBodies(fetchMock).length === 1) return olderResponse.promise;
      return successfulPut(String(body.content), 1);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
    fireEvent.change(editor, { target: { value: "older_network_write = 1\n" } });
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1), { timeout: 2_000 });
    const olderRecord = vi.mocked(repository.putDraft).mock.calls[0]?.[0];

    fireEvent.change(editor, { target: { value: "newer_committed_write = 2\n" } });
    await waitFor(() => expect(repository.putDraft).toHaveBeenCalledTimes(2));
    const newerRecord = vi.mocked(repository.putDraft).mock.calls[1]?.[0];
    expect(newerRecord?.requestId).not.toBe(olderRecord?.requestId);

    await act(async () => olderResponse.reject(new Error("older response was lost")));
    await screen.findByText("Saved locally on this browser. Codestead will retry automatically.");
    await userEvent.click(screen.getByRole("button", { name: "Retry sync" }));
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(2));
    expect(putBodies(fetchMock)[1]).toMatchObject({
      content: "newer_committed_write = 2\n",
      requestId: newerRecord?.requestId,
    });
    await screen.findByText("Saved to Codestead.");
    expect(repository.deleteDraftIfMutation).toHaveBeenCalledWith(
      namespace,
      key,
      newerRecord?.requestId,
    );
    expect(repository.deleteDraftIfMutation).not.toHaveBeenCalledWith(
      namespace,
      key,
      olderRecord?.requestId,
    );
    expect(editor).toHaveValue("newer_committed_write = 2\n");
  });

  it("rebases a newer durable edit after an older acknowledgement without deleting it", async () => {
    const firstAcknowledgement = deferred<Response>();
    const repository = installRepository({
      deleteDraftIfMutation: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });
    let puts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      puts += 1;
      return puts === 1
        ? firstAcknowledgement.promise
        : successfulPut("newer_edit = 2\n", 2);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
    fireEvent.change(editor, { target: { value: "older_edit = 1\n" } });
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1), { timeout: 2_000 });

    fireEvent.change(editor, { target: { value: "newer_edit = 2\n" } });
    await waitFor(() => expect(repository.putDraft).toHaveBeenCalledTimes(2));
    const firstRecord = vi.mocked(repository.putDraft).mock.calls[0]?.[0];
    const newerRecord = vi.mocked(repository.putDraft).mock.calls[1]?.[0];
    expect(newerRecord?.requestId).not.toBe(firstRecord?.requestId);
    expect(putBodies(fetchMock)).toHaveLength(1);

    await act(async () => firstAcknowledgement.resolve(successfulPut("older_edit = 1\n", 1)));
    await waitFor(() => expect(repository.putDraft).toHaveBeenCalledTimes(3));
    const rebasedRecord = vi.mocked(repository.putDraft).mock.calls[2]?.[0];
    expect(rebasedRecord).toMatchObject({
      requestId: newerRecord?.requestId,
      payload: { content: "newer_edit = 2\n", baseRevision: 1 },
    });
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(2), { timeout: 2_000 });
    expect(putBodies(fetchMock)[1]).toMatchObject({
      requestId: newerRecord?.requestId,
      content: "newer_edit = 2\n",
      expectedRowVersion: 1,
    });
    expect(editor).toHaveValue("newer_edit = 2\n");
  });

  it("adopts an external newer outbox record when compare-delete returns false", async () => {
    const externalRecord = outbox({
      content: "newer_other_tab = 2\n",
      requestId: "10000000-0000-4000-8000-000000000099",
    });
    const repository = installRepository({
      getDraft: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(externalRecord),
      deleteDraftIfMutation: async () => false,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return successfulPut(String(body.content), 1);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
    fireEvent.change(editor, { target: { value: "older_this_tab = 1\n" } });

    await waitFor(() => expect(repository.deleteDraftIfMutation).toHaveBeenCalledTimes(1), {
      timeout: 2_000,
    });
    await waitFor(() => expect(repository.getDraft).toHaveBeenCalledTimes(2));
    await screen.findByText(/newer server draft exists/i);
    expect(draftNotice()).toHaveAttribute("data-draft-status", "conflict");
    expect(editor).toHaveValue("newer_other_tab = 2\n");
    expect(repository.putDraft).toHaveBeenCalledTimes(1);
    expect(putBodies(fetchMock)).toHaveLength(1);
    expect(repository.deleteDraftIfMutation).toHaveBeenCalledWith(
      namespace,
      key,
      putBodies(fetchMock)[0]?.requestId,
    );

    fireEvent.change(editor, { target: { value: "must_not_bypass_external_conflict = 3\n" } });
    expect(editor).toHaveValue("newer_other_tab = 2\n");
    expect(screen.getByRole("button", { name: "Keep my draft" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use server draft" })).toBeInTheDocument();
  });

  it("blocks after acknowledgement cleanup loses and reread fails, then adopts the durable winner", async () => {
    const externalWinner = outbox({
      content: "ack_external_winner = 3\n",
      requestId: "10000000-0000-4000-8000-000000000096",
    });
    const repository = installRepository({
      getDraft: vi.fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error("winner reread failed"))
        .mockResolvedValueOnce(externalWinner),
      deleteDraftIfMutation: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false),
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return successfulPut(String(body.content), 1);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
    fireEvent.change(editor, { target: { value: "acknowledged_stale_a = 1\n" } });
    await screen.findByText(/another browser changed this draft/i);

    expect(draftNotice()).toHaveAttribute("data-draft-status", "conflict-recovery");
    expect(editor).toHaveValue("acknowledged_stale_a = 1\n");
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Keep my draft" })).not.toBeInTheDocument();
    expect(repository.deleteDraftIfMutation).toHaveBeenCalledWith(
      namespace,
      key,
      putBodies(fetchMock)[0]?.requestId,
    );

    fireEvent.change(editor, { target: { value: "must_not_replace_external_c = 2\n" } });
    expect(editor).toHaveValue("acknowledged_stale_a = 1\n");
    await userEvent.click(screen.getByRole("button", { name: "Reload browser draft" }));
    await waitFor(() => expect(editor).toHaveValue("ack_external_winner = 3\n"));
    expect(draftNotice()).toHaveAttribute("data-draft-status", "conflict");
    expect(screen.getByRole("button", { name: "Keep my draft" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use server draft" })).toBeInTheDocument();
    expect(repository.deleteDraftIfMutation).toHaveBeenCalledTimes(2);
  });

  it("rebases an edit queued while acknowledgement cleanup is settling", async () => {
    const cleanup = deferred<boolean>();
    const newerLocalCommit = deferred<void>();
    const repository = installRepository({
      putDraft: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => newerLocalCommit.promise)
        .mockResolvedValue(undefined),
      deleteDraftIfMutation: () => cleanup.promise,
    });
    let puts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      puts += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return successfulPut(String(body.content), puts);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
    fireEvent.change(editor, { target: { value: "acknowledged_first = 1\n" } });
    await waitFor(() => expect(repository.deleteDraftIfMutation).toHaveBeenCalledTimes(1), {
      timeout: 2_000,
    });

    await act(async () => {
      cleanup.resolve(true);
      queueMicrotask(() => {
        fireEvent.change(editor, { target: { value: "queued_during_cleanup = 2\n" } });
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(repository.putDraft).toHaveBeenCalledTimes(2));
    expect(putBodies(fetchMock)).toHaveLength(1);
    const queuedRecord = vi.mocked(repository.putDraft).mock.calls[1]?.[0];

    await act(async () => newerLocalCommit.resolve());
    await waitFor(() => expect(repository.putDraft).toHaveBeenCalledTimes(3));
    const rebasedRecord = vi.mocked(repository.putDraft).mock.calls[2]?.[0];
    expect(rebasedRecord).toMatchObject({
      requestId: queuedRecord?.requestId,
      payload: { content: "queued_during_cleanup = 2\n", baseRevision: 1 },
    });
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(2), { timeout: 2_000 });
    expect(putBodies(fetchMock)[1]).toMatchObject({
      requestId: queuedRecord?.requestId,
      content: "queued_during_cleanup = 2\n",
      expectedRowVersion: 1,
    });
  });

  it("retries online failures at exactly 1, 2, 5, 10, and 30 seconds without overlap", async () => {
    let activePuts = 0;
    let maximumActivePuts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      activePuts += 1;
      maximumActivePuts = Math.max(maximumActivePuts, activePuts);
      try {
        throw new Error("temporary network failure");
      } finally {
        activePuts -= 1;
      }
    });

    const view = renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
    vi.useFakeTimers();
    userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fireEvent.change(editor, { target: { value: "scheduled_retry = true\n" } });
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(putBodies(fetchMock)).toHaveLength(1);

    for (const [index, delay] of [1_000, 2_000, 5_000, 10_000, 30_000].entries()) {
      await act(async () => {
        vi.advanceTimersByTime(delay - 1);
        await Promise.resolve();
      });
      expect(putBodies(fetchMock)).toHaveLength(index + 1);
      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(putBodies(fetchMock)).toHaveLength(index + 2);
    }

    const bodies = putBodies(fetchMock);
    expect(new Set(bodies.map((body) => body.requestId)).size).toBe(1);
    expect(maximumActivePuts).toBe(1);
    view.unmount();
  });

  it("supersedes a stale 30-second retry with the newest committed edit without overlapping PUTs", async () => {
    const newerResponse = deferred<Response>();
    let activePuts = 0;
    let maximumActivePuts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      activePuts += 1;
      maximumActivePuts = Math.max(maximumActivePuts, activePuts);
      try {
        if (body.content === "older_backoff_edit = 1\n") {
          throw new Error("temporary network failure");
        }
        return await newerResponse.promise;
      } finally {
        activePuts -= 1;
      }
    });

    const view = renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "older_backoff_edit = 1\n" } });
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(putBodies(fetchMock)).toHaveLength(1);

    for (const delay of [1_000, 2_000, 5_000, 10_000]) {
      await act(async () => {
        vi.advanceTimersByTime(delay);
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    expect(putBodies(fetchMock)).toHaveLength(5);
    expect(putBodies(fetchMock).every((body) => body.content === "older_backoff_edit = 1\n"))
      .toBe(true);

    fireEvent.change(editor, { target: { value: "newest_committed_edit = 2\n" } });
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      vi.advanceTimersByTime(649);
      await Promise.resolve();
    });
    expect(putBodies(fetchMock)).toHaveLength(5);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(putBodies(fetchMock)).toHaveLength(6);
    expect(putBodies(fetchMock)[5]).toMatchObject({ content: "newest_committed_edit = 2\n" });
    expect(activePuts).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(putBodies(fetchMock)).toHaveLength(6);
    expect(maximumActivePuts).toBe(1);

    await act(async () => newerResponse.resolve(successfulPut("newest_committed_edit = 2\n", 1)));
    expect(draftNotice()).toHaveAttribute("data-draft-status", "synced");
    expect(activePuts).toBe(0);
    view.unmount();
  });

  it("never uploads a dirty warm-cache value without a matching durable record", async () => {
    writeDraftCache(window.sessionStorage, namespace, key, cached({
      content: "warm_only_must_not_upload = true\n",
    }));
    const getResponse = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return getResponse.promise;
      return successfulPut("warm_only_must_not_upload = true\n", 1);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue("warm_only_must_not_upload = true\n"));
    expect(putBodies(fetchMock)).toHaveLength(0);

    await act(async () => getResponse.resolve(json({ draft: null, cacheNamespace: namespace })));
    await waitFor(() => expect(editor).toHaveValue("# Try the idea here\n\n"));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    });
    expect(putBodies(fetchMock)).toHaveLength(0);
  });

  it("keeps an independent browser draft for every standalone runner language", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    const durableRecords = new Map<string, DraftOutboxRecord>();
    installRepository({
      getDraft: async (draftNamespace, draftKey) => durableRecords.get(
        draftOutboxStorageKey(draftNamespace, draftKey),
      ) ?? null,
      putDraft: async (record) => {
        durableRecords.set(record.storageKey, record);
      },
    });
    const requestedUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(init?.method).toBe("GET");
      requestedUrls.push(String(url));
      return json({ draft: null, cacheNamespace: namespace });
    });
    const user = userEvent.setup();
    renderStandaloneLab();

    const selector = screen.getByRole("combobox", { name: "Runner language" });
    let editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await screen.findByText("Saved to Codestead.");
    fireEvent.change(editor, { target: { value: "python_only = 41\n" } });
    await screen.findByText("Saved locally on this browser. Syncing to Codestead...");

    await user.selectOptions(selector, "c");
    editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain("#include <stdio.h>"));
    fireEvent.change(editor, { target: { value: "int c_only = 42;\n" } });

    for (const language of ["cpp", "java", "javascript"] as const) {
      await user.selectOptions(selector, language);
      editor = await screen.findByRole("textbox", { name: "Practice source code" });
      await waitFor(() => expect(requestedUrls.some((url) => url.includes(`courseId=${language}`) && url.includes(`language=${language}`))).toBe(true));
    }

    await user.selectOptions(selector, "python");
    editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue("python_only = 41\n"));

    await user.selectOptions(selector, "c");
    editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue("int c_only = 42;\n"));
    expect(requestedUrls).toEqual(expect.arrayContaining([
      expect.stringMatching(/courseId=python.*skillId=free-playground.*language=python/),
      expect.stringMatching(/courseId=c.*skillId=free-playground.*language=c/),
      expect.stringMatching(/courseId=cpp.*skillId=free-playground.*language=cpp/),
      expect.stringMatching(/courseId=java.*skillId=free-playground.*language=java/),
      expect.stringMatching(/courseId=javascript.*skillId=free-playground.*language=javascript/),
    ]));
    expect(JSON.parse(String(window.sessionStorage.getItem(draftCacheKey(namespace, {
      kind: "code",
      courseId: "python",
      skillId: "free-playground",
      language: "python",
    }))))).toMatchObject({ content: "python_only = 41\n", language: "python" });
    expect(JSON.parse(String(window.sessionStorage.getItem(draftCacheKey(namespace, {
      kind: "code",
      courseId: "c",
      skillId: "free-playground",
      language: "c",
    }))))).toMatchObject({ content: "int c_only = 42;\n", language: "c" });
  });

  it("restores server-synced work after cache eviction and a new device namespace", async () => {
    writeDraftCache(window.sessionStorage, "old-device-namespace", key, cached({
      content: "another_device_secret = true\n",
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      draft: serverDraft,
      cacheNamespace: namespace,
    }));

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue("server_answer = 42\n"));
    expect(editor).not.toHaveValue("another_device_secret = true\n");
    expect(screen.getByText("Saved to Codestead.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/drafts\?/),
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("recovers a durable offline edit, probes once, then accelerates the same mutation online", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    writeDraftCache(window.sessionStorage, namespace, key, cached());
    installRepository({ getDraft: async () => outbox() });
    const bodies: Record<string, unknown>[] = [];
    let attempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      attempts += 1;
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (attempts === 1) throw new Error("offline probe failed");
      return successfulPut("local_answer = 41\n", 1);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue("local_answer = 41\n"));
    expect(await screen.findByText(
      "Saved locally on this browser. Codestead will retry automatically.",
    )).toBeInTheDocument();
    expect(bodies).toHaveLength(1);

    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(bodies).toHaveLength(2), { timeout: 2_000 });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({
      requestId: "10000000-0000-4000-8000-000000000001",
      expectedRowVersion: 0,
      content: "local_answer = 41\n",
    });
    await screen.findByText("Saved to Codestead.");
  });

  it("retries a transport failure with the same request id instead of duplicating a mutation", async () => {
    const putBodies: Record<string, unknown>[] = [];
    let puts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      puts += 1;
      putBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (puts === 1) throw new Error("response lost");
      return json({
        draft: { ...serverDraft, content: "print('retry')\n", rowVersion: 1 },
        committedRowVersion: 1,
        replayed: true,
        cacheNamespace: namespace,
      });
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await screen.findByText("Saved to Codestead.");
    fireEvent.change(editor, { target: { value: "print('retry')\n" } });
    await screen.findByText("Saved locally on this browser. Codestead will retry automatically.");
    await userEvent.click(screen.getByRole("button", { name: "Retry sync" }));
    await waitFor(() => expect(putBodies).toHaveLength(2), { timeout: 2_000 });
    expect(putBodies[1]?.requestId).toBe(putBodies[0]?.requestId);
    await screen.findByText("Saved to Codestead.");
  });

  it("recovers the route-shaped idempotency mismatch with a fresh durable request", async () => {
    const acknowledgement = deferred<Response>();
    const repository = installRepository();
    let activePuts = 0;
    let maximumActivePuts = 0;
    let puts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      activePuts += 1;
      maximumActivePuts = Math.max(maximumActivePuts, activePuts);
      puts += 1;
      try {
        if (puts === 1) {
          return json({
            error: "This request ID was already used for different draft content.",
            code: "DRAFT_IDEMPOTENCY_MISMATCH",
          }, 409);
        }
        return await acknowledgement.promise;
      } finally {
        activePuts -= 1;
      }
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
    fireEvent.change(editor, { target: { value: "fresh_identity_needed = true\n" } });
    await screen.findByText(/could not reuse this saved request/i);
    expect(draftNotice()).toHaveAttribute("data-draft-status", "idempotency-mismatch");
    expect(screen.queryByText(/newer server draft exists/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
    expect(repository.deleteDraftIfMutation).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Retry with fresh request" }));
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(2), { timeout: 2_000 });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "PUT",
      "GET",
      "PUT",
    ]);
    expect(putBodies(fetchMock)[1]).toMatchObject({ content: "fresh_identity_needed = true\n" });
    expect(putBodies(fetchMock)[1]?.requestId).not.toBe(putBodies(fetchMock)[0]?.requestId);
    expect(maximumActivePuts).toBe(1);
    expect(repository.deleteDraftIfMutation).not.toHaveBeenCalled();

    await act(async () => acknowledgement.resolve(successfulPut("fresh_identity_needed = true\n", 1)));
    await screen.findByText("Saved to Codestead.");
    expect(repository.deleteDraftIfMutation).toHaveBeenCalledWith(
      namespace,
      key,
      putBodies(fetchMock)[1]?.requestId,
    );
  });

  it("keeps the route-shaped quota response durable and retries the same request on demand", async () => {
    const acknowledgement = deferred<Response>();
    const repository = installRepository();
    let activePuts = 0;
    let maximumActivePuts = 0;
    let puts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      activePuts += 1;
      maximumActivePuts = Math.max(maximumActivePuts, activePuts);
      puts += 1;
      try {
        if (puts === 1) {
          return json({
            error: "Draft quota exceeded.",
            code: "DRAFT_QUOTA_EXCEEDED",
            limit: 10,
          }, 409);
        }
        return await acknowledgement.promise;
      } finally {
        activePuts -= 1;
      }
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
    fireEvent.change(editor, { target: { value: "quota_safe_browser_copy = true\n" } });
    await screen.findByText(/draft storage limit is full/i);
    expect(draftNotice()).toHaveAttribute("data-draft-status", "quota-exceeded");
    expect(screen.queryByText(/newer server draft exists/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
    expect(repository.deleteDraftIfMutation).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Retry sync" }));
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(2), { timeout: 2_000 });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "PUT",
      "GET",
      "PUT",
    ]);
    expect(putBodies(fetchMock)[1]).toEqual(putBodies(fetchMock)[0]);
    expect(maximumActivePuts).toBe(1);
    expect(repository.deleteDraftIfMutation).not.toHaveBeenCalled();

    await act(async () => acknowledgement.resolve(successfulPut("quota_safe_browser_copy = true\n", 1)));
    await screen.findByText("Saved to Codestead.");
  });

  it.each([
    {
      action: "Retry with fresh request",
      code: "DRAFT_IDEMPOTENCY_MISMATCH",
      status: "idempotency-mismatch",
    },
    {
      action: "Retry sync",
      code: "DRAFT_QUOTA_EXCEEDED",
      status: "quota-exceeded",
    },
    {
      action: "Retry sync",
      code: "UNRECOGNIZED_DRAFT_CONFLICT",
      status: "offline-saved-local",
    },
  ])(
    "does not resend a durable $code mutation after recovery GET returns another namespace",
    async ({ action, code, status }) => {
      const repository = installRepository();
      let gets = 0;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        if (init?.method === "GET") {
          gets += 1;
          return json({
            draft: null,
            cacheNamespace: gets === 1 ? namespace : "rotated-session-namespace",
          });
        }
        return json({ code, error: "The request cannot be reconciled yet." }, 409);
      });

      const view = renderLab();
      const editor = await screen.findByRole("textbox", { name: "Practice source code" });
      await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", "synced"));
      fireEvent.change(editor, { target: { value: "must_stay_in_original_namespace = true\n" } });
      await waitFor(() => expect(draftNotice()).toHaveAttribute("data-draft-status", status));
      expect(repository.putDraft).toHaveBeenCalledTimes(1);

      await userEvent.click(screen.getByRole("button", { name: action }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
        "GET",
        "PUT",
        "GET",
      ]);
      expect(putBodies(fetchMock)).toHaveLength(1);
      expect(repository.putDraft).toHaveBeenCalledTimes(1);
      expect(repository.deleteDraftIfMutation).not.toHaveBeenCalled();
      expect(editor).toHaveValue("must_stay_in_original_namespace = true\n");
      view.unmount();
    },
  );

  it("retries an initial transient load failure even when no local draft exists", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ code: "DRAFT_STORE_UNAVAILABLE" }, 503))
      .mockResolvedValueOnce(json({ draft: null, cacheNamespace: namespace }));

    renderLab();
    expect(await screen.findByText(/sync is unavailable/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry sync" }));

    await screen.findByText("Saved to Codestead.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("treats an unauthorized draft scope as terminal and does not repeat forbidden writes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      code: "DRAFT_SCOPE_UNAVAILABLE",
      error: "The draft scope is unavailable.",
    }, 404));

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    expect(await screen.findByText(/outside an available server draft scope/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry sync" })).not.toBeInTheDocument();
    fireEvent.change(editor, { target: { value: "local_only = true\n" } });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    });

    expect(editor).toHaveValue("local_only = true\n");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it.each([
    { label: "missing", responseNamespace: undefined },
    { label: "different", responseNamespace: "rotated-session-namespace" },
  ])(
    "does not expose a valid server conflict copy with a $label response namespace",
    async ({ responseNamespace }) => {
      const repository = installRepository();
      const newer = { ...serverDraft, content: "must_not_cross_sessions = 99\n", rowVersion: 2 };
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        if (init?.method === "GET") return json({ draft: serverDraft, cacheNamespace: namespace });
        return json({
          code: "DRAFT_VERSION_CONFLICT",
          current: newer,
          ...(responseNamespace ? { cacheNamespace: responseNamespace } : {}),
        }, 409);
      });

      const view = renderLab();
      const editor = await screen.findByRole("textbox", { name: "Practice source code" });
      await waitFor(() => expect(editor).toHaveValue(serverDraft.content));
      fireEvent.change(editor, { target: { value: "original_session_local = 1\n" } });
      await waitFor(() => expect(draftNotice()).toHaveAttribute(
        "data-draft-status",
        "offline-saved-local",
      ));

      expect(editor).toHaveValue("original_session_local = 1\n");
      expect(screen.queryByText(/newer server draft exists/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Keep my draft" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Use server draft" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
      expect(repository.deleteDraftIfMutation).not.toHaveBeenCalled();
      expect(putBodies(fetchMock)).toHaveLength(1);
      view.unmount();
    },
  );

  it("does not overwrite newer server work and lets the learner explicitly rebase local text", async () => {
    const putBodies: Record<string, unknown>[] = [];
    let puts = 0;
    const newer = { ...serverDraft, content: "newer_server = 99\n", rowVersion: 2 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: serverDraft, cacheNamespace: namespace });
      puts += 1;
      const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
      putBodies.push(input);
      if (puts === 1) return json({
        code: "DRAFT_VERSION_CONFLICT",
        current: newer,
        cacheNamespace: namespace,
      }, 409);
      return json({
        draft: { ...newer, content: input.content as string, rowVersion: 3 },
        committedRowVersion: 3,
        replayed: false,
        cacheNamespace: namespace,
      });
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue(serverDraft.content));
    fireEvent.change(editor, { target: { value: "my_local_solution = 7\n" } });
    await waitFor(() => expect(screen.getByText(/newer server draft exists/i)).toBeInTheDocument(), { timeout: 2_000 });
    expect(editor).toHaveValue("my_local_solution = 7\n");

    await userEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
    await waitFor(() => expect(putBodies).toHaveLength(2), { timeout: 2_000 });
    expect(putBodies[1]).toMatchObject({ expectedRowVersion: 2, content: "my_local_solution = 7\n" });
    expect(putBodies[1]?.requestId).not.toBe(putBodies[0]?.requestId);
    await screen.findByText("Saved to Codestead.");
    expect(editor).toHaveValue("my_local_solution = 7\n");
  });

  it("keeps a 409 conflict resolvable instead of letting another edit dismiss it", async () => {
    const newer = { ...serverDraft, content: "newer_server = 99\n", rowVersion: 2 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: serverDraft, cacheNamespace: namespace });
      return json({ code: "DRAFT_VERSION_CONFLICT", current: newer, cacheNamespace: namespace }, 409);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue(serverDraft.content));
    fireEvent.change(editor, { target: { value: "conflicted_local = 1\n" } });
    await screen.findByText(/newer server draft exists/i);

    fireEvent.change(editor, { target: { value: "must_not_dismiss_conflict = 2\n" } });
    expect(editor).toHaveValue("conflicted_local = 1\n");
    expect(draftNotice()).toHaveAttribute("data-draft-status", "conflict");
    expect(screen.getByRole("button", { name: "Keep my draft" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use server draft" })).toBeInTheDocument();
  });

  it("adopts an external durable winner after Use server loses, then deletes that winner exactly", async () => {
    const externalWinner = outbox({
      content: "external_winner = 3\n",
      requestId: "10000000-0000-4000-8000-000000000099",
    });
    const repository = installRepository({
      getDraft: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(externalWinner),
      deleteDraftIfMutation: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });
    const newerServer = { ...serverDraft, content: "server_choice = 9\n", rowVersion: 2 };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: serverDraft, cacheNamespace: namespace });
      return json({
        code: "DRAFT_VERSION_CONFLICT",
        current: newerServer,
        cacheNamespace: namespace,
      }, 409);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue(serverDraft.content));
    fireEvent.change(editor, { target: { value: "stale_local_b = 2\n" } });
    await screen.findByText(/newer server draft exists/i);
    const staleRequestId = putBodies(fetchMock)[0]?.requestId;

    await userEvent.click(screen.getByRole("button", { name: "Use server draft" }));
    await waitFor(() => expect(editor).toHaveValue("external_winner = 3\n"));
    expect(draftNotice()).toHaveAttribute("data-draft-status", "conflict");
    expect(repository.deleteDraftIfMutation).toHaveBeenNthCalledWith(
      1,
      namespace,
      key,
      staleRequestId,
    );

    await userEvent.click(screen.getByRole("button", { name: "Use server draft" }));
    await waitFor(() => expect(editor).toHaveValue("server_choice = 9\n"));
    expect(repository.deleteDraftIfMutation).toHaveBeenNthCalledWith(
      2,
      namespace,
      key,
      externalWinner.requestId,
    );
    expect(screen.getByText("Saved to Codestead.")).toBeInTheDocument();
    expect(putBodies(fetchMock)).toHaveLength(1);
  });

  it("rebases the adopted external durable winner when the learner keeps the local side", async () => {
    const externalWinner = outbox({
      content: "external_winner_to_keep = 4\n",
      requestId: "10000000-0000-4000-8000-000000000098",
    });
    const repository = installRepository({
      getDraft: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(externalWinner),
      deleteDraftIfMutation: async () => false,
    });
    const newerServer = { ...serverDraft, content: "server_choice = 9\n", rowVersion: 2 };
    let puts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: serverDraft, cacheNamespace: namespace });
      puts += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (puts === 1) return json({
        code: "DRAFT_VERSION_CONFLICT",
        current: newerServer,
        cacheNamespace: namespace,
      }, 409);
      return successfulPut(String(body.content), 3);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue(serverDraft.content));
    fireEvent.change(editor, { target: { value: "stale_local_b = 2\n" } });
    await screen.findByText(/newer server draft exists/i);
    await userEvent.click(screen.getByRole("button", { name: "Use server draft" }));
    await waitFor(() => expect(editor).toHaveValue("external_winner_to_keep = 4\n"));

    await userEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(2), { timeout: 2_000 });
    expect(putBodies(fetchMock)[1]).toMatchObject({
      content: "external_winner_to_keep = 4\n",
      expectedRowVersion: 2,
    });
    expect(putBodies(fetchMock)[1]?.requestId).not.toBe(externalWinner.requestId);
    expect(repository.putDraft).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ content: "external_winner_to_keep = 4\n" }),
    }));
  });

  it("blocks stale Keep when the external winner cannot be read, then retries adoption", async () => {
    const externalWinner = outbox({
      content: "winner_after_retry = 5\n",
      requestId: "10000000-0000-4000-8000-000000000097",
    });
    const repository = installRepository({
      getDraft: vi.fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error("browser store temporarily unavailable"))
        .mockResolvedValueOnce(externalWinner),
      deleteDraftIfMutation: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });
    const newerServer = { ...serverDraft, content: "server_choice = 9\n", rowVersion: 2 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: serverDraft, cacheNamespace: namespace });
      return json({
        code: "DRAFT_VERSION_CONFLICT",
        current: newerServer,
        cacheNamespace: namespace,
      }, 409);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue(serverDraft.content));
    fireEvent.change(editor, { target: { value: "stale_local_b = 2\n" } });
    await screen.findByText(/newer server draft exists/i);

    await userEvent.click(screen.getByRole("button", { name: "Use server draft" }));
    await screen.findByText(/another browser changed this draft/i);
    expect(draftNotice()).toHaveAttribute("data-draft-status", "conflict-recovery");
    expect(editor).toHaveValue("stale_local_b = 2\n");
    expect(screen.queryByRole("button", { name: "Keep my draft" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Reload browser draft" }));
    await waitFor(() => expect(editor).toHaveValue("winner_after_retry = 5\n"));
    expect(draftNotice()).toHaveAttribute("data-draft-status", "conflict");
    await userEvent.click(screen.getByRole("button", { name: "Use server draft" }));
    await waitFor(() => expect(editor).toHaveValue("server_choice = 9\n"));
    expect(repository.deleteDraftIfMutation).toHaveBeenCalledTimes(3);
  });

  it("hides stale Keep after conditional deletion rejects, then adopts the external winner", async () => {
    const externalWinner = outbox({
      content: "winner_after_delete_rejection = 6\n",
      requestId: "10000000-0000-4000-8000-000000000095",
    });
    const repository = installRepository({
      getDraft: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(externalWinner),
      deleteDraftIfMutation: vi.fn()
        .mockRejectedValueOnce(new Error("conditional deletion unavailable"))
        .mockResolvedValueOnce(false),
    });
    const newerServer = { ...serverDraft, content: "server_choice = 9\n", rowVersion: 2 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: serverDraft, cacheNamespace: namespace });
      return json({
        code: "DRAFT_VERSION_CONFLICT",
        current: newerServer,
        cacheNamespace: namespace,
      }, 409);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue(serverDraft.content));
    fireEvent.change(editor, { target: { value: "local_choice = 1\n" } });
    await screen.findByText(/newer server draft exists/i);
    await userEvent.click(screen.getByRole("button", { name: "Use server draft" }));
    await waitFor(() => expect(repository.deleteDraftIfMutation).toHaveBeenCalledTimes(1));
    expect(editor).toHaveValue("local_choice = 1\n");
    expect(draftNotice()).toHaveAttribute("data-draft-status", "conflict-recovery");
    expect(screen.queryByRole("button", { name: "Keep my draft" })).not.toBeInTheDocument();
    fireEvent.change(editor, { target: { value: "must_not_overwrite_unseen_winner = 2\n" } });
    expect(editor).toHaveValue("local_choice = 1\n");

    await userEvent.click(screen.getByRole("button", { name: "Reload browser draft" }));
    await waitFor(() => expect(editor).toHaveValue("winner_after_delete_rejection = 6\n"));
    expect(repository.deleteDraftIfMutation).toHaveBeenCalledTimes(2);
    expect(draftNotice()).toHaveAttribute("data-draft-status", "conflict");
    expect(screen.getByRole("button", { name: "Keep my draft" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use server draft" })).toBeInTheDocument();
  });

  it("keeps an explicit conflict blocked when a newer local commit finishes afterward", async () => {
    const newerLocalCommit = deferred<void>();
    const olderResponse = deferred<Response>();
    const repository = installRepository({
      putDraft: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => newerLocalCommit.promise)
        .mockResolvedValue(undefined),
    });
    const newerServer = { ...serverDraft, content: "newer_server = 99\n", rowVersion: 2 };
    let puts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: serverDraft, cacheNamespace: namespace });
      puts += 1;
      return puts === 1
        ? olderResponse.promise
        : successfulPut("newer_local = 2\n", 3);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue(serverDraft.content));
    fireEvent.change(editor, { target: { value: "older_local = 1\n" } });
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1), { timeout: 2_000 });

    fireEvent.change(editor, { target: { value: "newer_local = 2\n" } });
    await waitFor(() => expect(repository.putDraft).toHaveBeenCalledTimes(2));
    await act(async () => olderResponse.resolve(json({
      code: "DRAFT_VERSION_CONFLICT",
      current: newerServer,
      cacheNamespace: namespace,
    }, 409)));
    expect(draftNotice()).toHaveAttribute("data-draft-status", "saving-local");
    expect(screen.queryByText(/newer server draft exists/i)).not.toBeInTheDocument();

    await act(async () => newerLocalCommit.resolve());
    await screen.findByText(/newer server draft exists/i);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    });
    expect(draftNotice()).toHaveAttribute("data-draft-status", "conflict");
    expect(putBodies(fetchMock)).toHaveLength(1);
    expect(editor).toHaveValue("newer_local = 2\n");

    await userEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(2), { timeout: 2_000 });
    expect(putBodies(fetchMock)[1]).toMatchObject({
      content: "newer_local = 2\n",
      expectedRowVersion: 2,
    });
    expect(putBodies(fetchMock)[1]?.requestId).not.toBe(putBodies(fetchMock)[0]?.requestId);
  });

  it("uses the server conflict copy only after exact conditional local deletion", async () => {
    const repository = installRepository();
    const newer = { ...serverDraft, content: "authoritative_server = 9\n", rowVersion: 2 };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: serverDraft, cacheNamespace: namespace });
      return json({ code: "DRAFT_VERSION_CONFLICT", current: newer, cacheNamespace: namespace }, 409);
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue(serverDraft.content));
    fireEvent.change(editor, { target: { value: "discard_after_choice = true\n" } });
    await screen.findByText(/newer server draft exists/i);
    const requestId = putBodies(fetchMock)[0]?.requestId;

    await userEvent.click(screen.getByRole("button", { name: "Use server draft" }));
    await waitFor(() => expect(editor).toHaveValue("authoritative_server = 9\n"));
    expect(repository.deleteDraftIfMutation).toHaveBeenCalledWith(namespace, key, requestId);
    expect(putBodies(fetchMock)).toHaveLength(1);
    expect(screen.getByText("Saved to Codestead.")).toBeInTheDocument();
  });

  it.each([401, 403] as const)(
    "purges the current cache and blocks sync after a %i session denial",
    async (status) => {
      const repository = installRepository();
      const otherSkill = { ...key, skillId: "python.loops" };
      writeDraftCache(window.sessionStorage, namespace, key, cached({ content: "revoked_draft = 1\n" }));
      writeDraftCache(window.sessionStorage, namespace, otherSkill, cached({ content: "also_private = 1\n" }));
      writeDraftCache(window.sessionStorage, "another-learner-namespace", key, cached({
        content: "other_learner_private = 1\n",
      }));
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ code: "AUTH_REQUIRED" }, status));

      renderLab();
      const editor = await screen.findByRole("textbox", { name: "Practice source code" });
      await waitFor(() => expect(screen.getByText(/session expired or was revoked/i)).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
      expect(editor).toHaveValue("# Try the idea here\n\n");
      expect(editor).not.toHaveValue("other_learner_private = 1\n");
      expect(window.sessionStorage.getItem(draftCacheKey(namespace, key))).toBeNull();
      expect(window.sessionStorage.getItem(draftCacheKey(namespace, otherSkill))).toBeNull();
      expect(window.sessionStorage.getItem(draftCacheKey("another-learner-namespace", key))).not.toBeNull();
      await waitFor(() => expect(repository.clearNamespace).toHaveBeenCalledWith(namespace));
      expect(repository.clearAll).not.toHaveBeenCalled();
      expect(repository.clearDrafts).not.toHaveBeenCalled();
      fireEvent.change(editor, { target: { value: "must_not_sync = 1\n" } });
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
      });
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
    },
  );

  it("handles a draft GET denial before consuming a stalled response body", async () => {
    const repository = installRepository();
    const denied = stalledDeniedResponse(401);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(denied.response);

    renderLab();

    await waitFor(() => expect(screen.getByText(/session expired or was revoked/i)).toBeInTheDocument());
    expect(denied.json).not.toHaveBeenCalled();
    expect(repository.clearNamespace).toHaveBeenCalledWith(namespace);
  });

  it("handles a draft PUT denial before consuming a rejected response body", async () => {
    const repository = installRepository();
    const rejectedJson = vi.fn().mockRejectedValue(new Error("body stream rejected"));
    const denied = { ok: false, status: 403, json: rejectedJson } as unknown as Response;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => (
      init?.method === "GET"
        ? json({ draft: serverDraft, cacheNamespace: namespace })
        : denied
    ));

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue(serverDraft.content));
    fireEvent.change(editor, { target: { value: "denied_put = true\n" } });

    await waitFor(() => expect(screen.getByText(/session expired or was revoked/i)).toBeInTheDocument(), {
      timeout: 2_000,
    });
    expect(rejectedJson).not.toHaveBeenCalled();
    expect(repository.clearNamespace).toHaveBeenCalledWith(namespace);
  });

  it("handles a closed-book draft GET before consuming a stalled response body", async () => {
    const repository = installRepository();
    const denied = stalledDeniedResponse(423);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(denied.response);

    renderLab();

    await waitFor(() => expect(screen.getByText(/locked during a closed-book exam/i))
      .toBeInTheDocument());
    expect(denied.json).not.toHaveBeenCalled();
    expect(repository.clearDrafts).toHaveBeenCalledWith(namespace);
    expect(repository.clearNamespace).not.toHaveBeenCalled();
    expect(repository.clearExamSession).not.toHaveBeenCalled();
  });

  it("handles a closed-book draft PUT before consuming a stalled response body", async () => {
    const repository = installRepository();
    const denied = stalledDeniedResponse(423);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => (
      init?.method === "GET"
        ? json({ draft: serverDraft, cacheNamespace: namespace })
        : denied.response
    ));

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue(serverDraft.content));
    fireEvent.change(editor, { target: { value: "must_lock_before_body = true\n" } });

    await waitFor(() => expect(screen.getByText(/locked during a closed-book exam/i))
      .toBeInTheDocument(), { timeout: 2_000 });
    expect(denied.json).not.toHaveBeenCalled();
    expect(repository.clearDrafts).toHaveBeenCalledWith(namespace);
    expect(repository.clearNamespace).not.toHaveBeenCalled();
    expect(repository.clearExamSession).not.toHaveBeenCalled();
  });

  it("removes local code assistance when a closed-book exam gate denies draft access", async () => {
    const repository = installRepository();
    writeDraftCache(window.sessionStorage, namespace, key, cached({ content: "exam_helper = 1\n" }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ code: "EXAM_CLOSED_BOOK" }, 423));
    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(screen.getByText(/locked during a closed-book exam/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(editor).toHaveValue("# Try the idea here\n\n");
    await waitFor(() => expect(repository.clearDrafts).toHaveBeenCalledWith(namespace));
    expect(repository.clearNamespace).not.toHaveBeenCalled();
    expect(repository.clearExamSession).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: "cannot_edit = true\n" } });
    expect(editor).toHaveValue("# Try the idea here\n\n");
  });
});
