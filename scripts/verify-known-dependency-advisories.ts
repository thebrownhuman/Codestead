import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;
type ReleaseVersion = readonly [major: number, minor: number, patch: number];

const EXPECTED_OVERRIDES = {
  esbuild: "0.25.12",
  postcss: "8.5.19",
} as const;

const ESBUILD_PATCH_FLOOR: ReleaseVersion = [0, 25, 0];
const POSTCSS_PATCH_FLOOR: ReleaseVersion = [8, 5, 10];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseReleaseVersion(value: unknown): ReleaseVersion | null {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;

  const version = match.slice(1).map(Number);
  if (version.some((part) => !Number.isSafeInteger(part))) return null;
  return version as unknown as ReleaseVersion;
}

function compareVersion(left: ReleaseVersion, right: ReleaseVersion) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function readNestedString(root: unknown, keys: readonly string[]) {
  let current: unknown = root;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" ? current : null;
}

function isLockedPackagePath(packagePath: string, packageName: "esbuild" | "postcss") {
  return (
    packagePath === `node_modules/${packageName}` ||
    packagePath.endsWith(`/node_modules/${packageName}`)
  );
}

export function verifyKnownDependencyAdvisories(manifest: unknown, lock: unknown) {
  const errors: string[] = [];

  const postcssOverride = readNestedString(manifest, ["overrides", "next", "postcss"]);
  if (postcssOverride !== EXPECTED_OVERRIDES.postcss) {
    errors.push(
      `The reviewed next -> postcss override must equal ${EXPECTED_OVERRIDES.postcss}; found ${postcssOverride ?? "missing"}.`,
    );
  }

  const esbuildOverride = readNestedString(manifest, [
    "overrides",
    "@esbuild-kit/core-utils",
    "esbuild",
  ]);
  if (esbuildOverride !== EXPECTED_OVERRIDES.esbuild) {
    errors.push(
      `The reviewed @esbuild-kit/core-utils -> esbuild override must equal ${EXPECTED_OVERRIDES.esbuild}; found ${esbuildOverride ?? "missing"}.`,
    );
  }

  if (!isRecord(lock) || lock.lockfileVersion !== 3 || !isRecord(lock.packages)) {
    errors.push("package-lock.json must use lockfileVersion 3 and contain a packages inventory.");
    return errors.sort();
  }

  let esbuildCount = 0;
  let postcssCount = 0;

  for (const [packagePath, metadata] of Object.entries(lock.packages)) {
    const packageKind = isLockedPackagePath(packagePath, "esbuild")
      ? "esbuild"
      : isLockedPackagePath(packagePath, "postcss")
        ? "postcss"
        : null;
    if (!packageKind) continue;

    if (packageKind === "esbuild") esbuildCount += 1;
    else postcssCount += 1;

    const versionValue = isRecord(metadata) ? metadata.version : null;
    const version = parseReleaseVersion(versionValue);
    if (!version) {
      errors.push(
        `${packagePath} has invalid version ${JSON.stringify(versionValue)}; only stable x.y.z releases are accepted.`,
      );
      continue;
    }

    if (packageKind === "esbuild" && compareVersion(version, ESBUILD_PATCH_FLOOR) < 0) {
      errors.push(
        `${packagePath}@${String(versionValue)} is affected by GHSA-67mh-4wv8-2f99; require >=0.25.0.`,
      );
    }
    if (packageKind === "postcss" && compareVersion(version, POSTCSS_PATCH_FLOOR) < 0) {
      errors.push(
        `${packagePath}@${String(versionValue)} is affected by GHSA-qx2v-qp2m-jg93; require >=8.5.10.`,
      );
    }
  }

  if (esbuildCount === 0) errors.push("No esbuild package was found in the lock inventory.");
  if (postcssCount === 0) errors.push("No postcss package was found in the lock inventory.");

  return errors.sort();
}

async function main() {
  const root = process.cwd();
  const [manifest, lock] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "package-lock.json"), "utf8").then(JSON.parse),
  ]);
  const errors = verifyKnownDependencyAdvisories(manifest, lock);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log("Known esbuild and PostCSS dependency advisories are absent from the release lock.");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
