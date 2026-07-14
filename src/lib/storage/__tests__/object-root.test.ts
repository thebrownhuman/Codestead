import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { objectStorageRoot } from "../object-root";

describe("objectStorageRoot", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses an explicitly configured absolute storage directory", () => {
    const absolute = path.resolve("safe-object-store");
    vi.stubEnv("OBJECT_STORAGE_PATH", absolute);
    expect(objectStorageRoot()).toBe(absolute);
  });

  it("rejects a relative configured directory", () => {
    vi.stubEnv("OBJECT_STORAGE_PATH", "relative/objects");
    expect(() => objectStorageRoot()).toThrow(/must be absolute/i);
  });

  it("fails over to the fixed production mount", () => {
    vi.stubEnv("OBJECT_STORAGE_PATH", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(objectStorageRoot()).toBe("/var/lib/learncoding/objects");
  });

  it("keeps the no-config development fallback outside the source tree", () => {
    vi.stubEnv("OBJECT_STORAGE_PATH", "");
    vi.stubEnv("NODE_ENV", "test");
    const root = objectStorageRoot();
    expect(path.isAbsolute(root)).toBe(true);
    expect(root).not.toContain(path.join(process.cwd(), ".data"));
    expect(root).toMatch(/learncoding-development-objects$/);
  });
});
