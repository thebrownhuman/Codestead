import { createHash } from "node:crypto";

function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
}

export function hashCurriculumValue(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function aggregateArtifactHash(
  artifacts: readonly { artifactKey: string; artifactType: string; contentHash: string }[],
): string {
  return hashCurriculumValue([...artifacts]
    .sort((left, right) =>
      (left.artifactKey < right.artifactKey ? -1 : left.artifactKey > right.artifactKey ? 1 : 0)
      || (left.artifactType < right.artifactType ? -1 : left.artifactType > right.artifactType ? 1 : 0)
      || (left.contentHash < right.contentHash ? -1 : left.contentHash > right.contentHash ? 1 : 0))
    .map(({ artifactKey, artifactType, contentHash }) => ({ artifactKey, artifactType, contentHash })));
}
