const generatedRepositoryArtifactDirectories = new Set([
  "playwright-report",
  "test-artifacts",
  "test-results",
]);

function normalizeRootRelativePath(value: string): string {
  let normalized = value.replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+$/u, "");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    segments.some((segment) => segment === "..")
  ) {
    throw new Error("Repository scanner exclusion rejected path traversal.");
  }
  return normalized;
}

export function isGeneratedRepositoryArtifactDirectory(
  relativeDirectoryPath: string,
): boolean {
  const normalized = normalizeRootRelativePath(relativeDirectoryPath);
  return (
    !normalized.includes("/") &&
    generatedRepositoryArtifactDirectories.has(normalized)
  );
}

export function isWithinGeneratedRepositoryArtifactDirectory(
  relativePath: string,
): boolean {
  const normalized = normalizeRootRelativePath(relativePath);
  const separatorIndex = normalized.indexOf("/");
  if (separatorIndex <= 0) return false;
  return isGeneratedRepositoryArtifactDirectory(
    normalized.slice(0, separatorIndex),
  );
}

export function isGeneratedNextOutputDirectory(relativeDirectoryPath: string): boolean {
  const normalized = normalizeRootRelativePath(relativeDirectoryPath);

  if (normalized.includes("/")) return false;
  return normalized === ".next" || normalized.startsWith(".next-e2e-");
}
