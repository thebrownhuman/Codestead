import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserOutboxRepository } from "@/lib/browser-durability/indexed-db";
import {
  EMERGENCY_EXAM_EVENT_PREFIX,
  writeEmergencyExamEvent,
} from "@/lib/browser-durability/emergency-events";
import { examEventOutboxStorageKey } from "@/lib/browser-durability/types";

import { draftCacheKey, writeDraftCache } from "../browser-cache";
import { signOutWithBrowserDurabilityCleanup } from "../logout";

const namespace = "session-one";

function repository(clearNamespace = vi.fn(async () => undefined)) {
  return {
    clearNamespace,
    close: vi.fn(),
  } as unknown as BrowserOutboxRepository;
}

function emergencyEvent() {
  return {
    schemaVersion: 1 as const,
    storageKey: examEventOutboxStorageKey(namespace, "session-alpha", "event-alpha-000001"),
    namespace,
    kind: "exam-event" as const,
    scope: "session-alpha",
    clientEventId: "event-alpha-000001",
    updatedAt: "2026-07-12T10:00:00.000Z",
    payload: {
      eventType: "window_blur" as const,
      occurredAt: "2026-07-12T10:00:00.000Z",
      metadata: {},
    },
  };
}

describe("draft-aware logout", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

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
    const repo = repository(vi.fn(async () => { events.push("indexed-db"); }));
    writeEmergencyExamEvent(window.localStorage, emergencyEvent());
    const signOut = vi.fn(async () => {
      events.push(`signout:${window.sessionStorage.length}:${window.localStorage.length}`);
    });
    const navigate = vi.fn((destination: string) => { events.push(`navigate:${destination}`); });

    await expect(signOutWithBrowserDurabilityCleanup({
      namespace,
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
      openRepository: async () => repo,
      signOut,
      navigate,
    })).resolves.toEqual({ cleanupSucceeded: true });

    expect(events).toEqual(["signout:2:1", "indexed-db", "navigate:/login"]);
    expect(window.sessionStorage.getItem("unrelated")).toBe("keep");
    const remainingKeys = Array.from(
      { length: window.localStorage.length },
      (_, index) => window.localStorage.key(index),
    ).filter((key): key is string => key !== null);
    expect(remainingKeys).toHaveLength(1);
    expect(remainingKeys[0]).toBe(
      "codestead:browser-recovery-boundary:v1:namespace:session-one",
    );
    expect(remainingKeys.some((key) => key.startsWith(EMERGENCY_EXAM_EVENT_PREFIX))).toBe(false);
    expect(repo.close).toHaveBeenCalledOnce();
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
    const repo = repository();
    await expect(signOutWithBrowserDurabilityCleanup({
      namespace,
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
      openRepository: async () => repo,
      signOut: async () => { throw new Error("offline"); },
      navigate,
    })).rejects.toThrow("offline");
    expect(window.sessionStorage.getItem(draftCacheKey("session-one", key))).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(repo.clearNamespace).not.toHaveBeenCalled();
    expect(repo.close).not.toHaveBeenCalled();
  });

  it("navigates after confirmed sign-out even when browser cleanup is partial", async () => {
    const sessionStorage = {
      get length() { throw new Error("storage disabled"); },
      getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), key: vi.fn(), clear: vi.fn(),
    } as unknown as Storage;
    const repo = repository(vi.fn(async () => { throw new Error("private database detail"); }));
    const signOut = vi.fn(async () => undefined);
    const navigate = vi.fn();
    await expect(signOutWithBrowserDurabilityCleanup({
      namespace,
      sessionStorage,
      localStorage: window.localStorage,
      openRepository: async () => repo,
      signOut,
      navigate,
    })).resolves.toEqual({ cleanupSucceeded: false });
    expect(signOut).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/login");
    expect(repo.close).toHaveBeenCalledOnce();
  });

  it("treats an explicit sign-out error as unconfirmed and preserves recovery", async () => {
    const key = { kind: "code" as const, courseId: "python", skillId: "variables", language: "python" };
    writeDraftCache(window.sessionStorage, namespace, key, {
      schemaVersion: 1, content: "keep = true\n", language: "python", baseRowVersion: 0,
      requestId: "10000000-0000-4000-8000-000000000002",
      locallyUpdatedAt: "2026-07-12T10:00:00.000Z", dirty: true,
    });
    const repo = repository();
    const navigate = vi.fn();

    await expect(signOutWithBrowserDurabilityCleanup({
      namespace,
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
      openRepository: async () => repo,
      signOut: async () => ({ error: { message: "network unavailable" } }),
      navigate,
    })).rejects.toThrow("Sign-out could not be confirmed");

    expect(window.sessionStorage.getItem(draftCacheKey(namespace, key))).not.toBeNull();
    expect(repo.clearNamespace).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
