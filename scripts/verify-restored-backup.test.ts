import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sealCredential } from "../src/lib/security/credential-vault";
import {
  verifyAppData,
  verifyCredentialProbe,
  verifyDatabaseSchema,
} from "./verify-restored-backup";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixtureRoot() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codestead-restore-smoke-"));
  temporary.push(directory);
  return directory;
}

describe("restore smoke verifier", () => {
  it("validates the required restored schema without trusting row data", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("information_schema.tables")) return { rows: [{ count: "18" }] };
        return {
          rows: [{
            migrations: "drizzle.__drizzle_migrations",
            users: "\"user\"",
            courses: "course",
            lessons: "lesson",
            enrollments: "enrollment",
          }],
        };
      },
    };

    await expect(verifyDatabaseSchema(client)).resolves.toEqual({ publicTableCount: 18 });
    expect(queries).toHaveLength(2);
  });

  it("opens the credential probe with the recovered master key", async () => {
    const root = await fixtureRoot();
    const key = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
    const keyPath = path.join(root, "credential_master_key");
    await writeFile(keyPath, `${key.toString("base64")}\n`, { mode: 0o600 });
    const context = {
      credentialId: "00000000-0000-4000-8000-000000000001",
      userId: "backup-recovery-probe",
      provider: "nvidia_nim",
      keyVersion: 1,
    };
    const plaintext = "fixture-provider-secret";
    const probePath = path.join(root, "credential-probe.json");
    await writeFile(probePath, `${JSON.stringify({
      version: 1,
      context,
      sealed: sealCredential(plaintext, context, key),
      plaintextSha256: createHash("sha256").update(plaintext).digest("hex"),
    })}\n`, { mode: 0o600 });

    await expect(verifyCredentialProbe(probePath, keyPath)).resolves.toBe(true);
    await writeFile(keyPath, `${Buffer.alloc(32, 9).toString("base64")}\n`, { mode: 0o600 });
    await expect(verifyCredentialProbe(probePath, keyPath)).rejects.toThrow();
  });

  it("verifies every restored application object against the manifest", async () => {
    const root = await fixtureRoot();
    const objects = path.join(root, "app-data");
    await mkdir(path.join(objects, "objects"), { recursive: true, mode: 0o700 });
    const objectPath = path.join(objects, "objects", "sentinel.txt");
    await writeFile(objectPath, "restored-object\n", { mode: 0o600 });
    const hash = createHash("sha256").update("restored-object\n").digest("hex");
    const manifest = path.join(root, "objects.sha256");
    await writeFile(manifest, `${hash}  objects/sentinel.txt\n`, { mode: 0o600 });

    await expect(verifyAppData(objects, manifest)).resolves.toEqual({ objectCount: 1 });
    await writeFile(objectPath, "changed\n", { mode: 0o600 });
    await expect(verifyAppData(objects, manifest)).rejects.toThrow();
  });

  it.each([
    [undefined, "restored table count is invalid"],
    [18, "restored table count is invalid"],
    ["not-a-count", "restored table count is invalid"],
    ["-1", "restored table count is invalid"],
    ["4", "restored database contains too few public tables"],
    ["9007199254740992", "restored database contains too few public tables"],
  ])("rejects corrupt public table count %j", async (count, message) => {
    const client = {
      async query() { return { rows: [{ count }] }; },
    };
    await expect(verifyDatabaseSchema(client)).rejects.toThrow(message);
  });

  it("rejects every missing required regclass", async () => {
    const valid = {
      migrations: "drizzle.__drizzle_migrations", users: "\"user\"",
      courses: "course", lessons: "lesson", enrollments: "enrollment",
    };
    for (const missing of [
      "migrations", "users", "courses", "lessons", "enrollments",
    ] as const) {
      let query = 0;
      const client = {
        async query() {
          query += 1;
          return query === 1
            ? { rows: [{ count: "18" }] }
            : { rows: [{ ...valid, [missing]: null }] };
        },
      };
      await expect(verifyDatabaseSchema(client)).rejects.toThrow(
        "restored database is missing a required application table",
      );
    }
    let query = 0;
    const noRow = {
      async query() {
        query += 1;
        return query === 1 ? { rows: [{ count: "18" }] } : { rows: [] };
      },
    };
    await expect(verifyDatabaseSchema(noRow)).rejects.toThrow(
      "restored database is missing a required application table",
    );
  });

  it("rejects malformed credential probe inventory and metadata without leaking plaintext", async () => {
    type Probe = {
      version: unknown;
      context: Record<string, unknown>;
      sealed: Record<string, unknown>;
      plaintextSha256: unknown;
      [key: string]: unknown;
    };
    const mutations: Array<[string, (probe: Probe) => void, RegExp]> = [
      ["envelope extra field", (probe) => { probe.extra = true; }, /inventory is invalid/],
      ["version", (probe) => { probe.version = 2; }, /metadata is invalid/],
      ["plaintext hash encoding", (probe) => { probe.plaintextSha256 = "z".repeat(64); }, /metadata is invalid/],
      ["context shape", (probe) => { probe.context.extra = true; }, /context is invalid/],
      ["context credential id", (probe) => { probe.context.credentialId = null; }, /context is invalid/],
      ["context user id", (probe) => { probe.context.userId = null; }, /context is invalid/],
      ["context provider", (probe) => { probe.context.provider = null; }, /context is invalid/],
      ["context key version", (probe) => { probe.context.keyVersion = 2; }, /context is invalid/],
      ["sealed shape", (probe) => { probe.sealed.extra = true; }, /inventory is invalid/],
      ["sealed ciphertext", (probe) => { probe.sealed.ciphertext = null; }, /metadata is invalid/],
      ["sealed wrapped key", (probe) => { probe.sealed.wrappedDataKey = null; }, /metadata is invalid/],
      ["sealed wrap IV", (probe) => { probe.sealed.wrapIv = null; }, /metadata is invalid/],
      ["sealed data IV", (probe) => { probe.sealed.dataIv = null; }, /metadata is invalid/],
      ["sealed auth tag", (probe) => { probe.sealed.authTag = null; }, /metadata is invalid/],
      ["sealed last four", (probe) => { probe.sealed.lastFour = null; }, /metadata is invalid/],
      ["sealed key version", (probe) => { probe.sealed.keyVersion = 2; }, /key version is invalid/],
      ["wrong plaintext hash", (probe) => { probe.plaintextSha256 = "b".repeat(64); }, /plaintext hash differs/],
    ];

    for (const [, mutate, expected] of mutations) {
      const root = await fixtureRoot();
      const key = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
      const keyPath = path.join(root, "credential_master_key");
      await writeFile(keyPath, `${key.toString("base64")}\n`, { mode: 0o600 });
      const context = {
        credentialId: "00000000-0000-4000-8000-000000000001",
        userId: "backup-recovery-probe", provider: "nvidia_nim", keyVersion: 1,
      };
      const plaintext = "fixture-provider-secret";
      const probe: Probe = {
        version: 1, context,
        sealed: sealCredential(plaintext, context, key) as unknown as Record<string, unknown>,
        plaintextSha256: createHash("sha256").update(plaintext).digest("hex"),
      };
      mutate(probe);
      const probePath = path.join(root, "credential-probe.json");
      await writeFile(probePath, `${JSON.stringify(probe)}\n`, { mode: 0o600 });
      const verification = verifyCredentialProbe(probePath, keyPath);
      await expect(verification).rejects.toThrow(expected);
      await expect(verification).rejects.not.toThrow(plaintext);
    }
  });

  it("closes protected credential files after a rejected probe", async () => {
    const root = await fixtureRoot();
    const key = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
    const keyPath = path.join(root, "credential_master_key");
    await writeFile(keyPath, `${key.toString("base64")}\n`, { mode: 0o600 });
    const context = {
      credentialId: "00000000-0000-4000-8000-000000000001",
      userId: "backup-recovery-probe", provider: "nvidia_nim", keyVersion: 1,
    };
    const plaintext = "fixture-provider-secret";
    const probePath = path.join(root, "credential-probe.json");
    await writeFile(probePath, `${JSON.stringify({
      version: 1, context, sealed: sealCredential(plaintext, context, key),
      plaintextSha256: "c".repeat(64),
    })}\n`, { mode: 0o600 });
    await expect(verifyCredentialProbe(probePath, keyPath)).rejects.toThrow(
      "credential probe plaintext hash differs",
    );
    await expect(rm(root, { recursive: true, force: false })).resolves.toBeUndefined();
    temporary.splice(temporary.indexOf(root), 1);
  });

  it.each([
    ["missing newline", "manifest-without-newline"],
    ["traversal", "traversal"],
    ["absolute path", "absolute"],
    ["duplicate path", "duplicate"],
    ["inventory count", "count"],
  ] as const)("rejects app-data manifest %s corruption", async (_name, kind) => {
    const root = await fixtureRoot();
    const objects = path.join(root, "app-data");
    await mkdir(path.join(objects, "objects"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(objects, "objects", "sentinel.txt"), "restored-object\n", { mode: 0o600 });
    const hash = createHash("sha256").update("restored-object\n").digest("hex");
    const valid = `${hash}  objects/sentinel.txt`;
    const content = kind === "manifest-without-newline" ? valid
      : kind === "traversal" ? `${hash}  ../sentinel.txt\n`
        : kind === "absolute" ? `${hash}  /sentinel.txt\n`
          : kind === "duplicate" ? `${valid}\n${valid}\n`
            : "";
    const manifest = path.join(root, "objects.sha256");
    await writeFile(manifest, content, { mode: 0o600 });
    await expect(verifyAppData(objects, manifest)).rejects.toThrow();
  });

  it("rejects noncanonical roots, unsafe object names, and unlisted restored objects", async () => {
    const root = await fixtureRoot();
    const objects = path.join(root, "app-data");
    await mkdir(path.join(objects, "objects"), { recursive: true, mode: 0o700 });
    const first = "first\n";
    const second = "second\n";
    await writeFile(path.join(objects, "objects", "first.txt"), first, { mode: 0o600 });
    await writeFile(path.join(objects, "objects", "second.txt"), second, { mode: 0o600 });
    const manifest = path.join(root, "objects.sha256");
    const firstHash = createHash("sha256").update(first).digest("hex");
    const ghostHash = createHash("sha256").update("ghost\n").digest("hex");
    await writeFile(manifest,
      `${firstHash}  objects/first.txt\n${ghostHash}  objects/ghost.txt\n`,
      { mode: 0o600 },
    );
    await expect(verifyAppData(objects, manifest)).rejects.toThrow(
      "restored object is absent from the manifest",
    );
    await expect(verifyAppData(path.relative(process.cwd(), objects), manifest)).rejects.toThrow(
      "restored app-data root must be an absolute canonical path",
    );

    const unsafeObjects = path.join(root, "unsafe-app-data");
    await mkdir(unsafeObjects, { recursive: true, mode: 0o700 });
    await writeFile(path.join(unsafeObjects, "bad name.txt"), "unsafe\n", { mode: 0o600 });
    await expect(verifyAppData(unsafeObjects, manifest)).rejects.toThrow(
      "restored application data contains an unsafe path",
    );
  });
});
