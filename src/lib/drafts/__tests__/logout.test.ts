import { beforeEach, describe, expect, it, vi } from "vitest";

import { draftCacheKey, writeDraftCache } from "../browser-cache";
import { signOutWithDraftCleanup } from "../logout";

describe("draft-aware logout", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("clears every Codestead session draft after durable sign-out and before navigation", async () => {
    const events: string[] = [];
    writeDraftCache(window.sessionStorage, "session-one", {
      kind: "code", courseId: "python", skillId: "variables", language: "python",
    }, {
      schemaVersion: 1,
      content: "private = true\n",
      language: "python",
      baseRowVersion: 1,
      requestId: "10000000-0000-4000-8000-000000000001",
      locallyUpdatedAt: "2026-07-12T10:00:00.000Z",
      dirty: false,
    });
    window.sessionStorage.setItem("unrelated", "keep");
    const signOut = vi.fn(async () => { events.push(`signout:${window.sessionStorage.length}`); });
    const navigate = vi.fn((destination: string) => { events.push(`navigate:${destination}`); });

    await expect(signOutWithDraftCleanup({
      storage: window.sessionStorage,
      signOut,
      navigate,
    })).resolves.toBe(1);

    expect(events).toEqual(["signout:2", "navigate:/login"]);
    expect(window.sessionStorage.getItem("unrelated")).toBe("keep");
  });

  it("preserves offline-only drafts and does not navigate when sign-out fails", async () => {
    const key = { kind: "code" as const, courseId: "python", skillId: "variables", language: "python" };
    writeDraftCache(window.sessionStorage, "session-one", key, {
      schemaVersion: 1,
      content: "only_local_copy = true\n",
      language: "python",
      baseRowVersion: 0,
      requestId: "10000000-0000-4000-8000-000000000002",
      locallyUpdatedAt: "2026-07-12T10:00:00.000Z",
      dirty: true,
    });
    const navigate = vi.fn();
    await expect(signOutWithDraftCleanup({
      storage: window.sessionStorage,
      signOut: async () => { throw new Error("offline"); },
      navigate,
    })).rejects.toThrow("offline");
    expect(window.sessionStorage.getItem(draftCacheKey("session-one", key))).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("still revokes the server session when browser storage is unavailable", async () => {
    const storage = {
      get length() { throw new Error("storage disabled"); },
      getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), key: vi.fn(), clear: vi.fn(),
    } as unknown as Storage;
    const signOut = vi.fn(async () => undefined);
    const navigate = vi.fn();
    await expect(signOutWithDraftCleanup({ storage, signOut, navigate })).resolves.toBe(0);
    expect(signOut).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/login");
  });
});
