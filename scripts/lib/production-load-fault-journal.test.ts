import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PRODUCTION_LOAD_FAULT_JOURNAL_FILENAME,
  PRODUCTION_LOAD_FAULT_JOURNAL_MAX_BYTES,
  PRODUCTION_LOAD_FAULT_JOURNAL_TEMP_FILENAME,
  clearProductionLoadFaultJournal,
  loadProductionLoadFaultJournal,
  publishProductionLoadFaultIntent,
  recoverProductionLoadFaultJournal,
  type ProductionLoadFaultJournalAccess,
  type ProductionLoadFaultJournalOperations,
} from "./production-load-fault-journal";

const RUNNER_VM_ID = "57b9ab11-f3a4-4ea8-a58e-e73d951f9d11";
const OTHER_RUNNER_VM_ID = "123e4567-e89b-42d3-a456-426614174000";
const CANDIDATE_RUN_IDENTITY = `sha256:${"a".repeat(64)}`;
const OTHER_CANDIDATE_RUN_IDENTITY = `sha256:${"b".repeat(64)}`;
const RECORDED_AT = "2026-07-20T04:05:06.007Z";
const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

async function privateRoot(prefix = "learncoding-fault-journal-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  if (process.platform !== "win32") await chmod(root, 0o700);
  return root;
}

function access(
  journalRoot: string,
  overrides: Partial<ProductionLoadFaultJournalAccess> = {},
): ProductionLoadFaultJournalAccess {
  return {
    journalRoot,
    project: "learncoding",
    runnerVmId: RUNNER_VM_ID,
    candidateRunIdentitySha256: CANDIDATE_RUN_IDENTITY,
    ...overrides,
  };
}

function publishInput(journalRoot: string) {
  return {
    ...access(journalRoot),
    faultId: "runner_service_restart" as const,
    recordedAt: RECORDED_AT,
  };
}

function expectedRecord() {
  return {
    schemaVersion: 1,
    faultId: "runner_service_restart",
    project: "learncoding",
    runnerVmId: RUNNER_VM_ID,
    candidateRunIdentitySha256: CANDIDATE_RUN_IDENTITY,
    recordedAt: RECORDED_AT,
    state: "active",
  } as const;
}

function canonical(record: unknown): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

async function writeRawJournal(journalRoot: string, bytes: string | Uint8Array): Promise<string> {
  const journalPath = path.join(journalRoot, PRODUCTION_LOAD_FAULT_JOURNAL_FILENAME);
  await writeFile(journalPath, bytes, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") await chmod(journalPath, 0o600);
  return journalPath;
}

describe("production load fault journal publication", () => {
  it("publishes only the exact schema-v1 active intent as canonical JSON with one LF", async () => {
    const journalRoot = await privateRoot();
    const secret = "provider-token-must-never-be-journaled";
    const artifact = await publishProductionLoadFaultIntent({
      ...publishInput(journalRoot),
      secret,
    } as ReturnType<typeof publishInput> & { readonly secret: string });

    const expectedBytes = canonical(expectedRecord());
    const actualBytes = await readFile(artifact.path);
    expect(actualBytes.toString("utf8")).toBe(expectedBytes);
    expect(actualBytes.toString("utf8")).not.toContain(secret);
    expect(Object.keys(JSON.parse(actualBytes.toString("utf8")) as object)).toEqual([
      "schemaVersion",
      "faultId",
      "project",
      "runnerVmId",
      "candidateRunIdentitySha256",
      "recordedAt",
      "state",
    ]);
    expect(artifact).toMatchObject({
      byteLength: Buffer.byteLength(expectedBytes),
      sha256: createHash("sha256").update(expectedBytes).digest("hex"),
      record: expectedRecord(),
    });
    expect((await stat(artifact.path)).isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(artifact.path)).mode & 0o777).toBe(0o600);
    }
  });

  it("orders the durable publication as write, file fsync, atomic rename, then directory fsync", async () => {
    const journalRoot = await privateRoot();
    const events: string[] = [];
    const operations: Partial<ProductionLoadFaultJournalOperations> = {
      async writeFile(handle: FileHandle, bytes: Uint8Array) {
        events.push("write");
        await handle.writeFile(bytes);
      },
      async syncFile(handle: FileHandle) {
        events.push("fsync-file");
        await handle.sync();
      },
      async rename(source: string, destination: string) {
        events.push("rename");
        await rename(source, destination);
      },
      async syncDirectory() {
        events.push("fsync-directory");
      },
    };

    const artifact = await publishProductionLoadFaultIntent({
      ...publishInput(journalRoot),
      operations,
    });

    expect(events).toEqual(["write", "fsync-file", "rename", "fsync-directory"]);
    expect(await readFile(artifact.path, "utf8")).toBe(canonical(expectedRecord()));
  });

  it("never overwrites an existing active journal", async () => {
    const journalRoot = await privateRoot();
    const first = await publishProductionLoadFaultIntent(publishInput(journalRoot));
    const before = await readFile(first.path);

    await expect(publishProductionLoadFaultIntent({
      ...publishInput(journalRoot),
      faultId: "app_container_restart",
    })).rejects.toThrow(/existing journal evidence/i);

    expect(await readFile(first.path)).toEqual(before);
    expect(await readdir(journalRoot)).toEqual([PRODUCTION_LOAD_FAULT_JOURNAL_FILENAME]);
  });

  it.each([
    ["project", "other-project"],
    ["runnerVmId", "not-a-vm-uuid"],
    ["candidateRunIdentitySha256", `sha256:${"A".repeat(64)}`],
    ["faultId", "host_docker_restart"],
    ["recordedAt", "2026-07-20T04:05:06Z"],
  ] as const)("rejects invalid %s before creating journal evidence", async (field, value) => {
    const journalRoot = await privateRoot();

    await expect(publishProductionLoadFaultIntent({
      ...publishInput(journalRoot),
      [field]: value,
    } as Parameters<typeof publishProductionLoadFaultIntent>[0])).rejects.toThrow(/invalid/i);

    expect(await readdir(journalRoot)).toEqual([]);
  });

  it("rejects relative and non-normalized private roots", async () => {
    const journalRoot = await privateRoot();

    await expect(loadProductionLoadFaultJournal(access("relative/state"))).rejects.toThrow(/absolute/i);
    const nonNormalized = journalRoot + path.sep + "child" + path.sep + "..";
    await expect(loadProductionLoadFaultJournal(access(nonNormalized))).rejects.toThrow(/normalized/i);
  });
});

describe("production load fault journal fail-closed loading", () => {
  it("returns an explicit empty state idempotently", async () => {
    const journalRoot = await privateRoot();
    const expected = {
      status: "empty",
      path: path.join(journalRoot, PRODUCTION_LOAD_FAULT_JOURNAL_FILENAME),
    };

    await expect(loadProductionLoadFaultJournal(access(journalRoot))).resolves.toEqual(expected);
    await expect(loadProductionLoadFaultJournal(access(journalRoot))).resolves.toEqual(expected);
  });

  it.each([
    ["partial JSON", "{\n  \"schemaVersion\": 1"],
    ["extra field", canonical({ ...expectedRecord(), secret: "not-allowed" })],
    ["missing field", canonical({ ...expectedRecord(), state: undefined })],
    ["non-canonical spacing", `${JSON.stringify(expectedRecord())}\n`],
    ["CRLF", canonical(expectedRecord()).replaceAll("\n", "\r\n")],
    ["missing final LF", canonical(expectedRecord()).slice(0, -1)],
    ["multiple final LFs", `${canonical(expectedRecord())}\n`],
    ["UTF-8 BOM", `\ufeff${canonical(expectedRecord())}`],
    ["zero bytes", ""],
  ])("rejects and preserves %s evidence", async (_label, bytes) => {
    const journalRoot = await privateRoot();
    const journalPath = await writeRawJournal(journalRoot, bytes);
    const before = await readFile(journalPath);

    await expect(loadProductionLoadFaultJournal(access(journalRoot))).rejects.toThrow();

    expect(await readFile(journalPath)).toEqual(before);
  });

  it("rejects and preserves an oversized journal before parsing it", async () => {
    const journalRoot = await privateRoot();
    const bytes = Buffer.alloc(PRODUCTION_LOAD_FAULT_JOURNAL_MAX_BYTES + 1, 0x61);
    const journalPath = await writeRawJournal(journalRoot, bytes);

    await expect(loadProductionLoadFaultJournal(access(journalRoot))).rejects.toThrow(/size/i);

    expect(await readFile(journalPath)).toEqual(bytes);
  });

  it.each([
    ["stale candidate/run", { candidateRunIdentitySha256: OTHER_CANDIDATE_RUN_IDENTITY }],
    ["wrong runner VM", { runnerVmId: OTHER_RUNNER_VM_ID }],
  ] as const)("rejects and preserves a %s identity", async (_label, override) => {
    const journalRoot = await privateRoot();
    const artifact = await publishProductionLoadFaultIntent(publishInput(journalRoot));
    const before = await readFile(artifact.path);

    await expect(loadProductionLoadFaultJournal(access(journalRoot, override))).rejects.toThrow(
      /identity mismatch/i,
    );

    expect(await readFile(artifact.path)).toEqual(before);
  });

  it("rejects a non-regular journal and preserves it", async () => {
    const journalRoot = await privateRoot();
    const journalPath = path.join(journalRoot, PRODUCTION_LOAD_FAULT_JOURNAL_FILENAME);
    await mkdir(journalPath);

    await expect(loadProductionLoadFaultJournal(access(journalRoot))).rejects.toThrow(/regular file/i);

    expect((await lstat(journalPath)).isDirectory()).toBe(true);
  });

  it("rejects a symbolic-link component of the private root on every platform", async () => {
    const parent = await privateRoot("learncoding-fault-journal-parent-");
    const realRoot = path.join(parent, "real");
    const linkedRoot = path.join(parent, "linked");
    await mkdir(realRoot, { mode: 0o700 });
    if (process.platform !== "win32") await chmod(realRoot, 0o700);
    await symlink(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    await expect(loadProductionLoadFaultJournal(access(linkedRoot))).rejects.toThrow(/symbolic link/i);

    expect((await lstat(linkedRoot)).isSymbolicLink()).toBe(true);
  });

  it("treats an abandoned exclusive temporary file as partial evidence", async () => {
    const journalRoot = await privateRoot();
    const temporaryPath = path.join(journalRoot, PRODUCTION_LOAD_FAULT_JOURNAL_TEMP_FILENAME);
    await writeFile(temporaryPath, "partial", { flag: "wx", mode: 0o600 });

    await expect(loadProductionLoadFaultJournal(access(journalRoot))).rejects.toThrow(
      /partial journal evidence/i,
    );

    expect(await readFile(temporaryPath, "utf8")).toBe("partial");
  });

  it.skipIf(process.platform === "win32")(
    "rejects an overly broad private-root mode on POSIX",
    async () => {
      const journalRoot = await privateRoot();
      await chmod(journalRoot, 0o755);

      await expect(loadProductionLoadFaultJournal(access(journalRoot))).rejects.toThrow(/root mode/i);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects an overly broad journal mode on POSIX",
    async () => {
      const journalRoot = await privateRoot();
      const journalPath = await writeRawJournal(journalRoot, canonical(expectedRecord()));
      await chmod(journalPath, 0o644);

      await expect(loadProductionLoadFaultJournal(access(journalRoot))).rejects.toThrow(/journal mode/i);

      expect((await stat(journalPath)).mode & 0o777).toBe(0o644);
    },
  );

  it.skipIf(typeof process.getuid !== "function")(
    "rejects an unexpected POSIX owner without modifying evidence",
    async () => {
      const journalRoot = await privateRoot();
      const artifact = await publishProductionLoadFaultIntent(publishInput(journalRoot));
      const before = await readFile(artifact.path);

      await expect(loadProductionLoadFaultJournal(access(journalRoot, {
        requiredOwnerUid: process.getuid!() + 1,
      }))).rejects.toThrow(/owner/i);

      expect(await readFile(artifact.path)).toEqual(before);
    },
  );
});

describe("production load fault journal identity-bound clearing", () => {
  it("clears only the unchanged opened active journal and fsyncs the directory", async () => {
    const journalRoot = await privateRoot();
    const artifact = await publishProductionLoadFaultIntent(publishInput(journalRoot));
    const loaded = await loadProductionLoadFaultJournal(access(journalRoot));
    if (loaded.status !== "active") throw new Error("expected active journal");
    const events: string[] = [];

    await expect(clearProductionLoadFaultJournal({
      ...access(journalRoot),
      expected: loaded.artifact,
      operations: {
        async unlink(target: string) {
          events.push("unlink");
          await unlink(target);
        },
        async syncDirectory() {
          events.push("fsync-directory");
        },
      },
    })).resolves.toEqual({ status: "cleared", record: expectedRecord() });

    expect(events).toEqual(["unlink", "fsync-directory"]);
    expect(loaded.artifact).toEqual(artifact);
    await expect(loadProductionLoadFaultJournal(access(journalRoot))).resolves.toMatchObject({
      status: "empty",
    });
  });

  it("rejects and preserves canonically tampered content after it was opened", async () => {
    const journalRoot = await privateRoot();
    await publishProductionLoadFaultIntent(publishInput(journalRoot));
    const loaded = await loadProductionLoadFaultJournal(access(journalRoot));
    if (loaded.status !== "active") throw new Error("expected active journal");
    const tamperedBytes = canonical({ ...expectedRecord(), recordedAt: "2026-07-20T04:05:07.007Z" });
    await writeFile(loaded.artifact.path, tamperedBytes, { flag: "w" });
    if (process.platform !== "win32") await chmod(loaded.artifact.path, 0o600);

    await expect(clearProductionLoadFaultJournal({
      ...access(journalRoot),
      expected: loaded.artifact,
    })).rejects.toThrow(/changed after it was opened/i);

    expect(await readFile(loaded.artifact.path, "utf8")).toBe(tamperedBytes);
  });

  it("rejects and preserves a same-content replacement with a different regular-file identity", async () => {
    const journalRoot = await privateRoot();
    await publishProductionLoadFaultIntent(publishInput(journalRoot));
    const loaded = await loadProductionLoadFaultJournal(access(journalRoot));
    if (loaded.status !== "active") throw new Error("expected active journal");
    const replacementPath = path.join(journalRoot, "replacement.json");
    const bytes = await readFile(loaded.artifact.path);
    await writeFile(replacementPath, bytes, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") await chmod(replacementPath, 0o600);
    await unlink(loaded.artifact.path);
    await rename(replacementPath, loaded.artifact.path);

    await expect(clearProductionLoadFaultJournal({
      ...access(journalRoot),
      expected: loaded.artifact,
    })).rejects.toThrow(/changed after it was opened/i);

    expect(await readFile(loaded.artifact.path)).toEqual(bytes);
  });

  it("fails closed when an expected active journal disappeared", async () => {
    const journalRoot = await privateRoot();
    await publishProductionLoadFaultIntent(publishInput(journalRoot));
    const loaded = await loadProductionLoadFaultJournal(access(journalRoot));
    if (loaded.status !== "active") throw new Error("expected active journal");
    await unlink(loaded.artifact.path);

    await expect(clearProductionLoadFaultJournal({
      ...access(journalRoot),
      expected: loaded.artifact,
    })).rejects.toThrow(/expected journal is missing/i);
  });
});

describe("production load fault journal recovery", () => {
  it("runs reset and verification against the active record before clearing it", async () => {
    const journalRoot = await privateRoot();
    const published = await publishProductionLoadFaultIntent(publishInput(journalRoot));
    const observations: string[] = [];

    const result = await recoverProductionLoadFaultJournal({
      ...access(journalRoot),
      async resetAndVerify(record) {
        observations.push(record.faultId);
        expect(await readFile(published.path, "utf8")).toBe(canonical(expectedRecord()));
      },
    });

    expect(result).toEqual({ status: "recovered", record: expectedRecord() });
    expect(observations).toEqual(["runner_service_restart"]);
    await expect(loadProductionLoadFaultJournal(access(journalRoot))).resolves.toMatchObject({
      status: "empty",
    });
  });

  it("leaves the active journal intact when reset or verification fails", async () => {
    const journalRoot = await privateRoot();
    const artifact = await publishProductionLoadFaultIntent(publishInput(journalRoot));
    const before = await readFile(artifact.path);

    await expect(recoverProductionLoadFaultJournal({
      ...access(journalRoot),
      async resetAndVerify() {
        throw new Error("reset verification failed");
      },
    })).rejects.toThrow("reset verification failed");

    expect(await readFile(artifact.path)).toEqual(before);
    await expect(loadProductionLoadFaultJournal(access(journalRoot))).resolves.toMatchObject({
      status: "active",
    });
  });

  it("does not call reset for the explicit empty state and remains idempotent", async () => {
    const journalRoot = await privateRoot();
    const resetAndVerify = vi.fn(async () => undefined);

    await expect(recoverProductionLoadFaultJournal({
      ...access(journalRoot), resetAndVerify,
    })).resolves.toMatchObject({ status: "empty" });
    await expect(recoverProductionLoadFaultJournal({
      ...access(journalRoot), resetAndVerify,
    })).resolves.toMatchObject({ status: "empty" });

    expect(resetAndVerify).not.toHaveBeenCalled();
  });
});

describe("production load fault journal filesystem failures", () => {
  it("preserves a partial exclusive temp file and refuses to report publication on write failure", async () => {
    const journalRoot = await privateRoot();
    const injected = new Error("simulated write failure");

    await expect(publishProductionLoadFaultIntent({
      ...publishInput(journalRoot),
      operations: {
        async writeFile(handle, bytes) {
          await handle.write(bytes.subarray(0, 12));
          throw injected;
        },
      },
    })).rejects.toThrow("simulated write failure");

    const temporaryPath = path.join(journalRoot, PRODUCTION_LOAD_FAULT_JOURNAL_TEMP_FILENAME);
    expect((await readFile(temporaryPath)).byteLength).toBe(12);
    await expect(loadProductionLoadFaultJournal(access(journalRoot))).rejects.toThrow(/partial/i);
  });

  it("preserves the complete temp evidence and refuses publication on file-fsync failure", async () => {
    const journalRoot = await privateRoot();

    await expect(publishProductionLoadFaultIntent({
      ...publishInput(journalRoot),
      operations: {
        async syncFile() {
          throw new Error("simulated file fsync failure");
        },
      },
    })).rejects.toThrow("simulated file fsync failure");

    expect(await readFile(
      path.join(journalRoot, PRODUCTION_LOAD_FAULT_JOURNAL_TEMP_FILENAME),
      "utf8",
    )).toBe(canonical(expectedRecord()));
    await expect(loadProductionLoadFaultJournal(access(journalRoot))).rejects.toThrow(/partial/i);
  });

  it("preserves the temp and reservation evidence and refuses publication on rename failure", async () => {
    const journalRoot = await privateRoot();

    await expect(publishProductionLoadFaultIntent({
      ...publishInput(journalRoot),
      operations: {
        async rename() {
          throw new Error("simulated rename failure");
        },
      },
    })).rejects.toThrow("simulated rename failure");

    expect(await readFile(
      path.join(journalRoot, PRODUCTION_LOAD_FAULT_JOURNAL_TEMP_FILENAME),
      "utf8",
    )).toBe(canonical(expectedRecord()));
    expect((await stat(path.join(journalRoot, PRODUCTION_LOAD_FAULT_JOURNAL_FILENAME))).size).toBe(0);
    await expect(loadProductionLoadFaultJournal(access(journalRoot))).rejects.toThrow(/partial/i);
  });

  it("surfaces directory-fsync failure while retaining the renamed active journal for recovery", async () => {
    const journalRoot = await privateRoot();

    await expect(publishProductionLoadFaultIntent({
      ...publishInput(journalRoot),
      operations: {
        async syncDirectory() {
          throw new Error("simulated directory fsync failure");
        },
      },
    })).rejects.toThrow("simulated directory fsync failure");

    await expect(loadProductionLoadFaultJournal(access(journalRoot))).resolves.toMatchObject({
      status: "active",
      artifact: { record: expectedRecord() },
    });
  });

  it("surfaces unlink failure and retains the exact active journal", async () => {
    const journalRoot = await privateRoot();
    const artifact = await publishProductionLoadFaultIntent(publishInput(journalRoot));
    const loaded = await loadProductionLoadFaultJournal(access(journalRoot));
    if (loaded.status !== "active") throw new Error("expected active journal");
    const before = await readFile(artifact.path);

    await expect(clearProductionLoadFaultJournal({
      ...access(journalRoot),
      expected: loaded.artifact,
      operations: {
        async unlink() {
          throw new Error("simulated unlink failure");
        },
      },
    })).rejects.toThrow("simulated unlink failure");

    expect(await readFile(artifact.path)).toEqual(before);
  });
});
