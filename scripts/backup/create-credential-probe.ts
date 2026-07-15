import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  parseMasterKey,
  sealCredential,
} from "../../src/lib/security/credential-vault";

const FIXED_KEY_PATH = "/run/secrets/credential_master_key";
const context = {
  credentialId: "00000000-0000-4000-8000-000000000001",
  userId: "backup-recovery-probe",
  provider: "nvidia_nim",
  keyVersion: 1,
} as const;

function currentUid() {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("numeric uid is unavailable");
  return uid;
}

async function existingOutputIsReplaceable(outputPath: string) {
  try {
    const metadata = await lstat(outputPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("output is not a replaceable regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function main() {
  const [outputArgument, keyArgument, ...extra] = process.argv.slice(2);
  if (!outputArgument || !keyArgument || extra.length !== 0) {
    throw new Error("invalid invocation");
  }

  const outputPath = path.resolve(outputArgument);
  const keyPath = path.resolve(keyArgument);
  if (
    !path.isAbsolute(outputArgument) ||
    !path.isAbsolute(keyArgument) ||
    outputPath === keyPath
  ) {
    throw new Error("paths must be distinct and absolute");
  }

  const outputDirectory = path.dirname(outputPath);
  const outputDirectoryMetadata = await lstat(outputDirectory);
  if (!outputDirectoryMetadata.isDirectory() || outputDirectoryMetadata.isSymbolicLink()) {
    throw new Error("output directory is unsafe");
  }
  if ((await realpath(outputDirectory)) !== outputDirectory) {
    throw new Error("output directory contains a symlink");
  }
  if (
    process.platform === "linux" &&
    ((outputDirectoryMetadata.mode & 0o7777) !== 0o700 ||
      outputDirectoryMetadata.uid !== currentUid())
  ) {
    throw new Error("output directory metadata is unsafe");
  }
  await existingOutputIsReplaceable(outputPath);

  const noFollow = process.platform === "linux" ? (constants.O_NOFOLLOW ?? 0) : 0;
  const keyHandle = await open(keyPath, constants.O_RDONLY | noFollow);
  let rawKey: Buffer | undefined;
  let masterKey: Buffer | undefined;
  let probeBytes: Buffer | undefined;
  let temporaryPath = "";
  try {
    const keyMetadata = await keyHandle.stat();
    if (!keyMetadata.isFile()) throw new Error("master key is not a regular file");
    if (process.platform === "linux") {
      const expectedOwner = keyPath === FIXED_KEY_PATH ? 0 : currentUid();
      if ((keyMetadata.mode & 0o7777) !== 0o440 || keyMetadata.uid !== expectedOwner) {
        throw new Error("master key metadata is unsafe");
      }
    }
    rawKey = await keyHandle.readFile();
    masterKey = parseMasterKey(rawKey.toString("utf8").trim());

    probeBytes = randomBytes(32);
    const plaintext = probeBytes.toString("base64url");
    const sealed = sealCredential(plaintext, context, masterKey);
    const payload = {
      version: 1,
      context,
      sealed,
      plaintextSha256: createHash("sha256").update(plaintext, "utf8").digest("hex"),
    };
    const serialized = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");

    temporaryPath = path.join(
      outputDirectory,
      `.${path.basename(outputPath)}.tmp.${randomBytes(12).toString("hex")}`,
    );
    const outputHandle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    try {
      await outputHandle.chmod(0o600);
      await outputHandle.writeFile(serialized);
      await outputHandle.sync();
    } finally {
      serialized.fill(0);
      await outputHandle.close();
    }
    await existingOutputIsReplaceable(outputPath);
    await rename(temporaryPath, outputPath);
    temporaryPath = "";
    if (process.platform === "linux") {
      const directoryHandle = await open(outputDirectory, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } finally {
    await keyHandle.close();
    rawKey?.fill(0);
    masterKey?.fill(0);
    probeBytes?.fill(0);
    if (temporaryPath) await rm(temporaryPath, { force: true });
  }

  process.stdout.write("credential_probe_created=true\n");
}

main().catch(() => {
  process.stderr.write("credential_probe_failed\n");
  process.exitCode = 1;
});
