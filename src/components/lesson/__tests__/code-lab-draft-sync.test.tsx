import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { draftCacheKey, writeDraftCache, type CachedLearnerDraft } from "@/lib/drafts/browser-cache";
import { DraftCacheNamespaceProvider } from "@/lib/drafts/browser-cache-context";
import { CodeLab } from "../lesson-workspace";

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

describe("CodeLab authoritative draft synchronization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    let id = 10;
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() =>
      `10000000-0000-4000-8000-${String(id++).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`,
    );
  });

  it("keeps an independent browser draft for every standalone runner language", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
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
    await waitFor(() => expect(screen.getByText(/saved on the server/i)).toBeInTheDocument());
    fireEvent.change(editor, { target: { value: "python_only = 41\n" } });
    expect(screen.getByText(/offline: changes exist only/i)).toBeInTheDocument();

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
    expect(screen.getByText(/saved on the server.*clearing this browser cache will not lose it/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/drafts\?/),
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("keeps offline edits local, labels them non-durable, then syncs the same mutation online", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    writeDraftCache(window.sessionStorage, namespace, key, cached());
    const putBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: null, cacheNamespace: namespace });
      putBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({
        draft: { ...serverDraft, content: "local_answer = 41\n", rowVersion: 1 },
        committedRowVersion: 1,
        replayed: false,
        cacheNamespace: namespace,
      });
    });

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(editor).toHaveValue("local_answer = 41\n"));
    expect(screen.getByText(/offline: changes exist only in this browser session/i)).toBeInTheDocument();
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);

    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(putBodies).toHaveLength(1), { timeout: 2_000 });
    expect(putBodies[0]).toMatchObject({
      requestId: "10000000-0000-4000-8000-000000000001",
      expectedRowVersion: 0,
      content: "local_answer = 41\n",
    });
    await waitFor(() => expect(screen.getByText(/saved on the server/i)).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByText(/saved on the server/i)).toBeInTheDocument());
    fireEvent.change(editor, { target: { value: "print('retry')\n" } });
    await waitFor(() => expect(screen.getByText(/sync is unavailable/i)).toBeInTheDocument(), { timeout: 2_000 });
    await userEvent.click(screen.getByRole("button", { name: "Retry sync" }));
    await waitFor(() => expect(putBodies).toHaveLength(2), { timeout: 2_000 });
    expect(putBodies[1]?.requestId).toBe(putBodies[0]?.requestId);
    await waitFor(() => expect(screen.getByText(/saved on the server/i)).toBeInTheDocument());
  });

  it("retries an initial transient load failure even when no local draft exists", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ code: "DRAFT_STORE_UNAVAILABLE" }, 503))
      .mockResolvedValueOnce(json({ draft: null, cacheNamespace: namespace }));

    renderLab();
    expect(await screen.findByText(/sync is unavailable/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry sync" }));

    await waitFor(() => expect(screen.getByText(/saved on the server/i)).toBeInTheDocument());
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

  it("does not overwrite newer server work and lets the learner explicitly rebase local text", async () => {
    const putBodies: Record<string, unknown>[] = [];
    let puts = 0;
    const newer = { ...serverDraft, content: "newer_server = 99\n", rowVersion: 2 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return json({ draft: serverDraft, cacheNamespace: namespace });
      puts += 1;
      const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
      putBodies.push(input);
      if (puts === 1) return json({ code: "DRAFT_VERSION_CONFLICT", current: newer }, 409);
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
    await waitFor(() => expect(screen.getByText(/saved on the server/i)).toBeInTheDocument());
    expect(editor).toHaveValue("my_local_solution = 7\n");
  });

  it("purges the current cache and blocks sync after session revocation", async () => {
    const otherSkill = { ...key, skillId: "python.loops" };
    writeDraftCache(window.sessionStorage, namespace, key, cached({ content: "revoked_draft = 1\n" }));
    writeDraftCache(window.sessionStorage, namespace, otherSkill, cached({ content: "also_private = 1\n" }));
    writeDraftCache(window.sessionStorage, "another-learner-namespace", key, cached({
      content: "other_learner_private = 1\n",
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ code: "AUTH_REQUIRED" }, 401));

    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(screen.getByText(/session expired or was revoked/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(editor).toHaveValue("# Try the idea here\n\n");
    expect(editor).not.toHaveValue("other_learner_private = 1\n");
    expect(window.sessionStorage.getItem(draftCacheKey(namespace, key))).toBeNull();
    expect(window.sessionStorage.getItem(draftCacheKey(namespace, otherSkill))).toBeNull();
    expect(window.sessionStorage.getItem(draftCacheKey("another-learner-namespace", key))).not.toBeNull();
    fireEvent.change(editor, { target: { value: "must_not_sync = 1\n" } });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
  });

  it("removes local code assistance when a closed-book exam gate denies draft access", async () => {
    writeDraftCache(window.sessionStorage, namespace, key, cached({ content: "exam_helper = 1\n" }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ code: "EXAM_CLOSED_BOOK" }, 423));
    renderLab();
    const editor = await screen.findByRole("textbox", { name: "Practice source code" });
    await waitFor(() => expect(screen.getByText(/locked during a closed-book exam/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(editor).toHaveValue("# Try the idea here\n\n");
    fireEvent.change(editor, { target: { value: "cannot_edit = true\n" } });
    expect(editor).toHaveValue("# Try the idea here\n\n");
  });
});
