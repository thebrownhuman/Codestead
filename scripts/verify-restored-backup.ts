import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "pg";

import {
  openCredential,
  parseMasterKey,
  type CredentialContext,
  type SealedCredential,
} from "../src/lib/security/credential-vault";

interface QueryResultLike {
  rows: Array<Record<string, unknown>>;
}

export interface QueryClientLike {
  query(sql: string): Promise<QueryResultLike>;
}

const requiredTables = [
  "migrations",
  "users",
  "courses",
  "lessons",
  "enrollments",
] as const;

function requireAbsolute(value: string, label: string) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error(`${label} must be an absolute canonical path`);
  }
  return value;
}

async function readSecureRegularFile(filePath: string, expectedMode = 0o600) {
  requireAbsolute(filePath, "protected file");
  const parent = path.dirname(filePath);
  if ((await realpath(parent)) !== parent) throw new Error("protected file parent is unsafe");
  const noFollow = process.platform === "linux" ? (constants.O_NOFOLLOW ?? 0) : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("protected path is not a regular file");
    if (process.platform === "linux") {
      const uid = process.getuid?.();
      if (uid === undefined || metadata.uid !== uid || (metadata.mode & 0o7777) !== expectedMode) {
        throw new Error("protected file metadata is unsafe");
      }
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function exactObject(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export async function verifyDatabaseSchema(client: QueryClientLike) {
  const countResult = await client.query(
    "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
  );
  const countValue = countResult.rows[0]?.count;
  if (typeof countValue !== "string" || !/^[0-9]+$/.test(countValue)) {
    throw new Error("restored table count is invalid");
  }
  const publicTableCount = Number(countValue);
  if (!Number.isSafeInteger(publicTableCount) || publicTableCount < requiredTables.length) {
    throw new Error("restored database contains too few public tables");
  }

  const requiredResult = await client.query(`
    SELECT
      to_regclass('drizzle.__drizzle_migrations')::text AS migrations,
      to_regclass('public."user"')::text AS users,
      to_regclass('public.course')::text AS courses,
      to_regclass('public.lesson')::text AS lessons,
      to_regclass('public.enrollment')::text AS enrollments
  `);
  const required = requiredResult.rows[0];
  if (!required || requiredTables.some((table) => typeof required[table] !== "string" || !required[table])) {
    throw new Error("restored database is missing a required application table");
  }
  return { publicTableCount };
}

export async function verifyCredentialProbe(probePath: string, masterKeyPath: string) {
  const probeBytes = await readSecureRegularFile(probePath);
  const keyBytes = await readSecureRegularFile(masterKeyPath);
  let masterKey: Buffer | undefined;
  try {
    const probe = JSON.parse(probeBytes.toString("utf8")) as unknown;
    if (!exactObject(probe, ["version", "context", "sealed", "plaintextSha256"])) {
      throw new Error("credential probe inventory is invalid");
    }
    const record = probe as Record<string, unknown>;
    if (record.version !== 1 || typeof record.plaintextSha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(record.plaintextSha256)) {
      throw new Error("credential probe metadata is invalid");
    }
    if (!exactObject(record.context, ["credentialId", "userId", "provider", "keyVersion"])) {
      throw new Error("credential probe context is invalid");
    }
    const contextRecord = record.context as Record<string, unknown>;
    if (
      typeof contextRecord.credentialId !== "string" ||
      typeof contextRecord.userId !== "string" ||
      typeof contextRecord.provider !== "string" ||
      contextRecord.keyVersion !== 1
    ) {
      throw new Error("credential probe context is invalid");
    }
    if (!exactObject(record.sealed, [
      "ciphertext", "wrappedDataKey", "wrapIv", "dataIv", "authTag", "keyVersion", "lastFour",
    ])) {
      throw new Error("sealed credential inventory is invalid");
    }
    const sealedRecord = record.sealed as Record<string, unknown>;
    for (const key of ["ciphertext", "wrappedDataKey", "wrapIv", "dataIv", "authTag", "lastFour"] as const) {
      if (typeof sealedRecord[key] !== "string") throw new Error("sealed credential metadata is invalid");
    }
    if (sealedRecord.keyVersion !== 1) throw new Error("sealed credential key version is invalid");

    masterKey = parseMasterKey(keyBytes.toString("utf8").trim());
    const plaintext = openCredential(
      record.sealed as unknown as SealedCredential,
      record.context as CredentialContext,
      masterKey,
    );
    const actual = createHash("sha256").update(plaintext, "utf8").digest();
    const expected = Buffer.from(record.plaintextSha256, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("credential probe plaintext hash differs");
    }
    return true;
  } finally {
    probeBytes.fill(0);
    keyBytes.fill(0);
    masterKey?.fill(0);
  }
}

async function collectRegularFiles(root: string, relative = ""): Promise<string[]> {
  const directory = relative ? path.join(root, relative) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (!/^[A-Za-z0-9._/-]+$/.test(child) || child.includes("..") || child.startsWith("/")) {
      throw new Error("restored application data contains an unsafe path");
    }
    if (entry.isSymbolicLink()) throw new Error("restored application data contains a symlink");
    if (entry.isDirectory()) output.push(...await collectRegularFiles(root, child));
    else if (entry.isFile()) output.push(child);
    else throw new Error("restored application data contains a special file");
    if (output.length > 100_000) throw new Error("restored application data exceeds the object bound");
  }
  return output;
}

export async function verifyAppData(appDataRoot: string, manifestPath: string) {
  requireAbsolute(appDataRoot, "restored app-data root");
  const metadata = await lstat(appDataRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(appDataRoot)) !== appDataRoot) {
    throw new Error("restored app-data root is unsafe");
  }
  const manifestBytes = await readSecureRegularFile(manifestPath);
  try {
    const expected = new Map<string, Buffer>();
    const text = manifestBytes.toString("utf8");
    if (text && !text.endsWith("\n")) throw new Error("app-data manifest is not newline terminated");
    for (const line of text.split("\n").filter(Boolean)) {
      const match = /^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$/.exec(line);
      if (!match || match[2].includes("..") || match[2].startsWith("/") || expected.has(match[2])) {
        throw new Error("app-data manifest is invalid");
      }
      expected.set(match[2], Buffer.from(match[1], "hex"));
    }
    const actualFiles = (await collectRegularFiles(appDataRoot)).sort();
    if (actualFiles.length !== expected.size) throw new Error("app-data object inventory differs");
    for (const relative of actualFiles) {
      const expectedHash = expected.get(relative);
      if (!expectedHash) throw new Error("restored object is absent from the manifest");
      const bytes = await readSecureRegularFile(path.join(appDataRoot, ...relative.split("/")));
      try {
        const actualHash = createHash("sha256").update(bytes).digest();
        if (!timingSafeEqual(actualHash, expectedHash)) throw new Error("restored object hash differs");
      } finally {
        bytes.fill(0);
      }
    }
    return { objectCount: actualFiles.length };
  } finally {
    manifestBytes.fill(0);
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.RESTORE_DATABASE_URL;
  const appDataRoot = process.env.RESTORE_APP_DATA_ROOT;
  const appDataManifest = process.env.RESTORE_APP_DATA_MANIFEST;
  const credentialProbe = process.env.RESTORE_CREDENTIAL_PROBE;
  const masterKeyFile = process.env.CREDENTIAL_MASTER_KEY_FILE;
  if (!databaseUrl || !appDataRoot || !appDataManifest || !credentialProbe || !masterKeyFile) {
    throw new Error("restore smoke environment is incomplete");
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await verifyDatabaseSchema(client);
    await verifyAppData(appDataRoot, appDataManifest);
    await verifyCredentialProbe(credentialProbe, masterKeyFile);
  } finally {
    await client.end();
  }
  process.stdout.write(
    "database_schema_valid=true\napp_data_valid=true\ncredential_recovery=true\n",
  );
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  main().catch(() => {
    process.stderr.write("restore_smoke_failed\n");
    process.exitCode = 1;
  });
}
