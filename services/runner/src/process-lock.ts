import { fstatSync, lstatSync } from "node:fs";
import path from "node:path";
import { RunnerError } from "./errors.js";

const PROCESS_LOCK_FILE = ".runner-process.lock";

function invalid(message: string): never {
  throw new RunnerError(
    "INFRASTRUCTURE_ERROR",
    `runner inherited process lock ${message}`,
    500,
    true,
  );
}

export function verifyInheritedProcessLock(
  stateRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.RUNNER_PROCESS_LOCK_HELD !== "1") {
    invalid("marker is missing");
  }
  const rawDescriptor = env.RUNNER_PROCESS_LOCK_FD;
  if (rawDescriptor === undefined || !/^\d{1,4}$/.test(rawDescriptor)) {
    invalid("descriptor is missing");
  }
  const descriptor = Number(rawDescriptor);
  if (!Number.isSafeInteger(descriptor) || descriptor < 3) {
    invalid("descriptor is invalid");
  }

  let descriptorStats;
  let pathStats;
  try {
    // Windows file indexes can exceed Number.MAX_SAFE_INTEGER. BigInt stats
    // prevent two different files from comparing equal after precision loss.
    descriptorStats = fstatSync(descriptor, { bigint: true });
    pathStats = lstatSync(
      path.join(path.resolve(stateRoot), PROCESS_LOCK_FILE),
      { bigint: true },
    );
  } catch {
    invalid("descriptor could not be inspected");
  }
  if (
    !descriptorStats.isFile() ||
    !pathStats.isFile() ||
    pathStats.isSymbolicLink() ||
    descriptorStats.nlink !== 1n ||
    pathStats.nlink !== 1n ||
    descriptorStats.dev !== pathStats.dev ||
    descriptorStats.ino !== pathStats.ino
  ) {
    invalid("descriptor does not match its regular lock file");
  }
  if (process.platform !== "win32") {
    if (
      (descriptorStats.mode & 0o7777n) !== 0o600n ||
      (pathStats.mode & 0o7777n) !== 0o600n
    ) {
      invalid("file permissions must be 600");
    }
    const uid = process.getuid?.();
    if (
      uid !== undefined &&
      (descriptorStats.uid !== BigInt(uid) || pathStats.uid !== BigInt(uid))
    ) {
      invalid("file must be owned by the runner user");
    }
  }
}
