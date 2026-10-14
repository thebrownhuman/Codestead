// Shipped under src/ for standalone app and worker images. The sync test checks
// this projection against the reviewed infra handoff and publication manifest.
import runtimePins from "./piston-runtime-pins.json";
import type { RunnerLanguage } from "@/lib/runner/client";
import { configuredCodeRunnerProvider } from "@/lib/runner/provider-config";
import { PISTON_RUNTIMES } from "@/lib/runner/piston-client";
import { pinnedPistonImageDigest } from "@/lib/runner/exam-client";

import type { ExamFormSnapshot, ExamItem } from "./contracts";

const { handoff, publicationPins } = runtimePins;

export const PISTON_EXAM_PIN_REVISION = "piston-pr4b-v1";

/** The Piston manifest digest new forms pin: the deployed, digest-pinned
 * PISTON_IMAGE. Builds are reproducible per builder but not across BuildKit
 * versions, so the pin follows the image actually running. Fails closed when
 * PISTON_IMAGE is unset, a tag, or malformed.
 */
export function pistonExamImageDigest(): string {
  return pinnedPistonImageDigest(process.env.PISTON_IMAGE ?? "");
}

export function publishedExamPinRevision(): typeof PISTON_EXAM_PIN_REVISION | undefined {
  configuredCodeRunnerProvider();
  validateHandoff();
  if (!process.env.PISTON_URL) throw new Error("Piston exam publication requires the configured endpoint.");
  pistonExamImageDigest();
  return PISTON_EXAM_PIN_REVISION;
}

function validateHandoff() {
  if (publicationPins.schemaVersion !== 1 || publicationPins.revision !== PISTON_EXAM_PIN_REVISION
    || handoff.schemaVersion !== 1 || !handoff.validation.passed || handoff.validation.liveTests !== 20) {
    throw new Error("Unverified Piston publication runtime handoff.");
  }
  for (const language of Object.keys(PISTON_RUNTIMES) as RunnerLanguage[]) {
    const recorded = handoff.runtimeLabels[language];
    const expected = PISTON_RUNTIMES[language];
    if (recorded.language !== expected.language || recorded.version !== expected.version || recorded.label !== expected.label) {
      throw new Error("Piston publication runtime labels differ from the reviewed handoff.");
    }
  }
}

function legacyPin(language: RunnerLanguage, runtime: NonNullable<ExamItem["runtime"]>) {
  const record = publicationPins.legacyPins[language];
  return record.imageDigest === runtime.imageDigest && record.versions.includes(runtime.version);
}

/** A Piston pin for the currently deployed image (new forms). */
function pistonPin(language: RunnerLanguage, runtime: NonNullable<ExamItem["runtime"]>) {
  return runtime.version === handoff.runtimeLabels[language].label && runtime.imageDigest === pistonExamImageDigest();
}

/** A Piston pin stored on an earlier form, possibly from a previously deployed
 * image. Only ever retained verbatim, never adopted for a new form. */
function storedPistonPin(language: RunnerLanguage, runtime: NonNullable<ExamItem["runtime"]>) {
  return runtime.version === handoff.runtimeLabels[language].label && /^sha256:[a-f0-9]{64}$/.test(runtime.imageDigest ?? "");
}

/** Apply the reviewed, runtime-only publication revision BEFORE storing a new form.
 * Only independently reviewed DB publications opt into this at admission.
 * Never run this on a stored attempt, or mutate the source bank or its oracles.
 */
export function pinPublishedExamItemsToPiston(items: readonly ExamItem[]): readonly ExamItem[] {
  validateHandoff();
  const imageDigest = pistonExamImageDigest();
  return items.map((item) => {
    if (item.kind !== "code") return item;
    if (!item.runtime || !item.language || !(item.language in PISTON_RUNTIMES)
      || item.gradingEvidence.kind !== "runner-tests") throw new Error("Published code item has no reviewed runner pins.");
    const language = item.language as RunnerLanguage;
    if (!legacyPin(language, item.runtime) && !pistonPin(language, item.runtime)) {
      throw new Error("Published code item is outside the reviewed runtime pin migration.");
    }
    return { ...item, runtime: { version: handoff.runtimeLabels[language].label, imageDigest } };
  });
}

/** Retakes/rechecks retain the source lineage's exact pins before the existing
 * full equivalent-form validator runs. Only the reviewed pin pairs may cross
 * the rollout boundary; arbitrary runtime changes still fail parity.
 */
export function retainEquivalentExamRuntimePins(source: ExamFormSnapshot, candidate: ExamFormSnapshot): ExamFormSnapshot {
  validateHandoff();
  return { ...candidate, items: candidate.items.map((item) => {
    const prior = source.items.find((entry) => entry.skillId === item.skillId && entry.clusterId === item.clusterId);
    if (item.kind !== "code" || prior?.kind !== "code" || !item.runtime || !prior.runtime
      || !item.language || item.language !== prior.language || !(item.language in PISTON_RUNTIMES)) return item;
    const language = item.language as RunnerLanguage;
    if ((legacyPin(language, prior.runtime) && pistonPin(language, item.runtime))
      || (storedPistonPin(language, prior.runtime) && legacyPin(language, item.runtime))) {
      return { ...item, runtime: { ...prior.runtime } };
    }
    return item;
  }) };
}
