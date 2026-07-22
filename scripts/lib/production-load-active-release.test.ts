import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertProductionLoadActiveReleaseUnchanged,
  readProductionLoadActiveRelease,
} from "./production-load-active-release";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codestead-active-release-"));
  roots.push(root);
  const activeReleasePath = path.join(root, "active-release.env");
  const text = "SCHEMA_VERSION=1\n";
  await writeFile(activeReleasePath, text, { flag: "wx", mode: 0o644 });
  await chmod(activeReleasePath, 0o644);
  const options = {
    activeReleasePath,
    requiredMode: process.platform === "win32" ? null : 0o644,
    ...(typeof process.getuid === "function" ? { requiredOwnerUid: process.getuid() } : {}),
  };
  return { activeReleasePath, text, options };
}

describe("production load active release artifact", () => {
  it("returns canonical bytes plus a stable hash from a single-link regular file", async () => {
    const setup = await fixture();
    const artifact = await readProductionLoadActiveRelease(setup.options);
    expect(artifact.path).toBe(setup.activeReleasePath);
    expect(artifact.text).toBe(setup.text);
    expect(artifact.byteLength).toBe(Buffer.byteLength(setup.text));
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects a replacement after the artifact was authorized", async () => {
    const setup = await fixture();
    const artifact = await readProductionLoadActiveRelease(setup.options);
    await writeFile(setup.activeReleasePath, "SCHEMA_VERSION=2\n");
    await expect(assertProductionLoadActiveReleaseUnchanged(
      artifact,
      setup.options,
    )).rejects.toThrow(/active_release_changed/);
  });

  it("rejects symlinks and unsafe modes", async () => {
    const setup = await fixture();
    const linkPath = path.join(path.dirname(setup.activeReleasePath), "link.env");
    await symlink(setup.activeReleasePath, linkPath, "file");
    await expect(readProductionLoadActiveRelease({
      ...setup.options,
      activeReleasePath: linkPath,
    })).rejects.toThrow(/unsafe_file/);
    if (process.platform !== "win32") {
      await chmod(setup.activeReleasePath, 0o666);
      await expect(readProductionLoadActiveRelease(setup.options)).rejects.toThrow(/unsafe_file/);
    }
  });

  it("rejects noncanonical line endings, NUL, BOM, and oversized bytes", async () => {
    const setup = await fixture();
    for (const bytes of [
      "SCHEMA_VERSION=1\r\n",
      "SCHEMA_VERSION=1\0\n",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("SCHEMA_VERSION=1\n")]),
      Buffer.alloc(64 * 1024 + 1, 0x61),
    ]) {
      await writeFile(setup.activeReleasePath, bytes);
      await expect(readProductionLoadActiveRelease(setup.options)).rejects.toThrow(
        /^Production load active release failed: /,
      );
    }
  });
});
