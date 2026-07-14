export function isGeneratedNextOutputDirectory(relativeDirectoryPath: string): boolean {
  const normalized = relativeDirectoryPath
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "");

  if (normalized.includes("/")) return false;
  return normalized === ".next" || normalized.startsWith(".next-e2e-");
}
