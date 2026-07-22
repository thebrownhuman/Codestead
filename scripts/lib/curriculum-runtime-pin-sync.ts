import type { LocalRuntimeLanguage } from "./local-runtime-identity";

const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;
interface LocalBuildIdentityRecord {
  readonly id: LocalRuntimeLanguage;
  readonly tag: string;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly reference: string;
}


export interface RuntimePinSyncResult<T> {
  readonly value: T;
  readonly changed: boolean;
  readonly matchedByLanguage: Readonly<Record<LocalRuntimeLanguage, number>>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

export function manifestDigestMap(records: readonly LocalBuildIdentityRecord[]): Readonly<Record<LocalRuntimeLanguage, string>> {
  const entries = records.map((record) => [record.id, record.manifestDigest] as const);
  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<LocalRuntimeLanguage, string>>;
}

export function syncAssessmentBankRuntimePins<T>(
  bank: T,
  digests: Readonly<Record<LocalRuntimeLanguage, string>>,
): RuntimePinSyncResult<T> {
  const value = structuredClone(bank);
  const candidate = object(value, "Assessment bank");
  if (!Array.isArray(candidate.items)) throw new Error("Assessment bank items must be an array.");
  const counts: Record<LocalRuntimeLanguage, number> = { c: 0, cpp: 0, java: 0, javascript: 0, python: 0 };
  let changed = false;
  for (const [index, rawItem] of candidate.items.entries()) {
    const item = object(rawItem, `Assessment item ${index}`);
    if (item.kind !== "code") continue;
    const runtime = object(item.runtime, `Assessment item ${index} runtime`);
    if (runtime.engine !== "isolated-runner") continue;
    if (typeof runtime.language !== "string" || !(runtime.language in counts)) {
      throw new Error(`Assessment item ${index} has unsupported isolated-runner language '${String(runtime.language)}'.`);
    }
    const language = runtime.language as LocalRuntimeLanguage;
    const next = digests[language];
    if (!OCI_DIGEST.test(next)) throw new Error(`Pinned digest for ${language} is invalid.`);
    if (typeof runtime.imageDigest !== "string" || !OCI_DIGEST.test(runtime.imageDigest)) {
      throw new Error(`Assessment item ${index} has an invalid current image digest.`);
    }
    counts[language] += 1;
    if (runtime.imageDigest !== next) {
      runtime.imageDigest = next;
      changed = true;
    }
  }
  return { value, changed, matchedByLanguage: counts };
}
export function syncAssessmentBankRuntimePinText(
  source: string,
  digests: Readonly<Record<LocalRuntimeLanguage, string>>,
): RuntimePinSyncResult<string> {
  const synchronized = syncAssessmentBankRuntimePins(JSON.parse(source) as unknown, digests);
  const bank = object(synchronized.value, "Synchronized assessment bank");
  const items = bank.items as unknown[];
  const desired = items.flatMap((rawItem, index) => {
    const item = object(rawItem, `Assessment item ${index}`);
    if (item.kind !== "code") return [];
    const runtime = object(item.runtime, `Assessment item ${index} runtime`);
    return runtime.engine === "isolated-runner" ? [String(runtime.imageDigest)] : [];
  });
  let cursor = 0;
  const value = source.replace(
    /("imageDigest"\s*:\s*")sha256:[a-f0-9]{64}(")/g,
    (_match, prefix: string, suffix: string) => {
      const next = desired[cursor++];
      if (!next) throw new Error("Assessment bank contains an unexpected imageDigest field.");
      return `${prefix}${next}${suffix}`;
    },
  );
  if (cursor !== desired.length) {
    throw new Error(`Assessment bank contains ${cursor} textual imageDigest fields for ${desired.length} isolated-runner items.`);
  }
  return { value, changed: value !== source, matchedByLanguage: synchronized.matchedByLanguage };
}


export function syncPinnedCurriculumRuntimeSource(
  source: string,
  digests: Readonly<Record<LocalRuntimeLanguage, string>>,
): { readonly value: string; readonly changed: boolean } {
  let value = source;
  for (const language of ["java", "python"] as const) {
    const pattern = new RegExp(`(${language}:\\s*\\{[\\s\\S]*?imageDigest:\\s*")[^"]+("[\\s\\S]*?\\n\\s*\\},)`);
    const matches = [...value.matchAll(new RegExp(pattern.source, "g"))];
    if (matches.length !== 1) throw new Error(`Pinned runtime source must contain exactly one ${language} digest field; found ${matches.length}.`);
    value = value.replace(pattern, `$1${digests[language]}$2`);
  }
  return { value, changed: value !== source };
}
