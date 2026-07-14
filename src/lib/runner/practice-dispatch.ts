import { createHash } from "node:crypto";

import { z } from "zod";

import { hashRunnerAdmissionRequest, type RunnerAdmission } from "./admission";
import type { RunnerLanguage, RunnerRequest } from "./client";

export const PRACTICE_LIMITS = Object.freeze({
  wallTimeMs: 5_000,
  memoryMb: 128,
  cpuCount: 0.5,
  pids: 32,
  outputBytes: 65_536,
  fileBytes: 16_777_216,
});

const limitsSchema = z.object({
  wallTimeMs: z.literal(PRACTICE_LIMITS.wallTimeMs),
  memoryMb: z.literal(PRACTICE_LIMITS.memoryMb),
  cpuCount: z.literal(PRACTICE_LIMITS.cpuCount),
  pids: z.literal(PRACTICE_LIMITS.pids),
  outputBytes: z.literal(PRACTICE_LIMITS.outputBytes),
  fileBytes: z.literal(PRACTICE_LIMITS.fileBytes),
}).strict();

const dispatchSchema = z.object({
  submissionId: z.string().uuid(),
  correlationId: z.string().regex(/^practice-correlation-[0-9a-f]{48}$/),
  language: z.enum(["c", "cpp", "java", "python", "javascript"]),
  runtimeVersion: z.string().min(1).max(100),
  mode: z.enum(["COMPILE", "RUN"]),
  sourceFiles: z.array(z.object({
    path: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    content: z.string().min(1).max(131_072),
  }).strict()).length(1),
  entrypoint: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  stdin: z.string().max(16_384).optional(),
  limits: limitsSchema,
}).strict();

export function practiceCorrelationId(requestId: string) {
  return `practice-correlation-${createHash("sha256").update(requestId).digest("hex").slice(0, 48)}`;
}

export function practiceAdmissionRequestHash(input: {
  userId: string;
  requestId: string;
  language: RunnerLanguage;
  sourceHash: string;
  stdin?: string;
  mode: "compile" | "quick_run";
  runtimeVersion: string;
  entrypoint: string;
  submissionType: "server_compile" | "server_run";
}) {
  return hashRunnerAdmissionRequest({
    schemaVersion: 1,
    userId: input.userId,
    requestId: input.requestId,
    language: input.language,
    sourceHash: input.sourceHash,
    stdin: input.stdin ?? null,
    mode: input.mode,
    runtimeVersion: input.runtimeVersion,
    entrypoint: input.entrypoint,
    submissionType: input.submissionType,
    limits: PRACTICE_LIMITS,
  });
}

export function buildPracticeRunnerRequest(input: {
  admission: RunnerAdmission;
  language: RunnerLanguage;
  runtimeVersion: string;
  entrypoint: string;
  sourceCode: string;
  stdin?: string;
  mode: "compile" | "quick_run";
}): RunnerRequest {
  return {
    submissionId: input.admission.submissionId,
    correlationId: practiceCorrelationId(input.admission.requestId),
    language: input.language,
    runtimeVersion: input.runtimeVersion,
    mode: input.mode === "compile" ? "COMPILE" : "RUN",
    sourceFiles: [{ path: input.entrypoint, content: input.sourceCode }],
    entrypoint: input.entrypoint,
    ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
    limits: { ...PRACTICE_LIMITS },
  };
}

export function buildBoundPracticeRunnerRequest(input: {
  admission: RunnerAdmission;
  language: RunnerLanguage;
  runtimeVersion: string;
  entrypoint: string;
  sourceCode: string;
  sourceHash: string;
  stdin?: string;
  mode: "compile" | "quick_run";
}): RunnerRequest {
  const request = buildPracticeRunnerRequest(input);
  return validatePracticeDispatchSnapshot({
    snapshot: request,
    submissionId: input.admission.submissionId,
    userId: input.admission.userId,
    requestId: input.admission.requestId,
    requestHash: input.admission.requestHash,
    submissionType: input.admission.submissionType,
    language: input.language,
    sourceCode: input.sourceCode,
    sourceHash: input.sourceHash,
  });
}

export class PracticeDispatchSnapshotError extends Error {
  constructor(public readonly code: "INVALID_SNAPSHOT" | "SNAPSHOT_BINDING_MISMATCH") {
    super(code);
    this.name = "PracticeDispatchSnapshotError";
  }
}

export function validatePracticeDispatchSnapshot(input: {
  snapshot: unknown;
  submissionId: string;
  userId: string;
  requestId: string;
  requestHash: string;
  submissionType: string;
  language: string;
  sourceCode: string;
  sourceHash: string;
}): RunnerRequest {
  const parsed = dispatchSchema.safeParse(input.snapshot);
  if (!parsed.success) throw new PracticeDispatchSnapshotError("INVALID_SNAPSHOT");
  const request = parsed.data;
  const file = request.sourceFiles[0]!;
  const expectedMode = input.submissionType === "server_compile"
    ? "COMPILE"
    : input.submissionType === "server_run"
      ? "RUN"
      : null;
  const computedSourceHash = createHash("sha256").update(input.sourceCode).digest("hex");
  const computedRequestHash = practiceAdmissionRequestHash({
    userId: input.userId,
    requestId: input.requestId,
    language: request.language,
    sourceHash: computedSourceHash,
    stdin: request.stdin,
    mode: request.mode === "COMPILE" ? "compile" : "quick_run",
    runtimeVersion: request.runtimeVersion,
    entrypoint: request.entrypoint,
    submissionType: input.submissionType as "server_compile" | "server_run",
  });
  if (
    expectedMode === null
    || request.submissionId !== input.submissionId
    || request.correlationId !== practiceCorrelationId(input.requestId)
    || request.language !== input.language
    || request.mode !== expectedMode
    || request.entrypoint !== file.path
    || file.content !== input.sourceCode
    || computedSourceHash !== input.sourceHash
    || computedRequestHash !== input.requestHash
  ) throw new PracticeDispatchSnapshotError("SNAPSHOT_BINDING_MISMATCH");
  return request;
}
