import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { RunnerAdmission } from "../admission";
import { serializeRunnerRequest } from "../client";
import {
  buildPracticeRunnerRequest,
  buildBoundPracticeRunnerRequest,
  practiceAdmissionRequestHash,
  PracticeDispatchSnapshotError,
  validatePracticeDispatchSnapshot,
} from "../practice-dispatch";

const sourceCode = "print('recover me')\n";
const sourceHash = createHash("sha256").update(sourceCode).digest("hex");
const admission: RunnerAdmission = {
  submissionId: "10000000-0000-4000-8000-000000000001",
  runnerJobId: "10000000-0000-4000-8000-000000000002",
  userId: "learner-one",
  requestId: "10000000-0000-4000-8000-000000000003",
  requestHash: practiceAdmissionRequestHash({
    userId: "learner-one",
    requestId: "10000000-0000-4000-8000-000000000003",
    language: "python",
    sourceHash,
    stdin: "Ada\n",
    mode: "quick_run",
    runtimeVersion: "Python 3.14",
    entrypoint: "main.py",
    submissionType: "server_run",
  }),
  submissionType: "server_run",
  status: "queued",
  remoteJobId: null,
  result: null,
  runtimeImageDigest: "pending-runner-result",
  queuedAt: new Date("2026-07-13T00:00:00.000Z"),
  duplicate: false,
};

describe("durable practice dispatch snapshots", () => {
  it("rejects a changed stdin or runtime before any caller can cross the remote boundary", () => {
    expect(() => buildBoundPracticeRunnerRequest({
      admission,
      language: "python",
      runtimeVersion: "Python 3.14",
      entrypoint: "main.py",
      sourceCode,
      sourceHash,
      stdin: "tampered input\n",
      mode: "quick_run",
    })).toThrow(PracticeDispatchSnapshotError);
    expect(() => buildBoundPracticeRunnerRequest({
      admission,
      language: "python",
      runtimeVersion: "Python 9.99",
      entrypoint: "main.py",
      sourceCode,
      sourceHash,
      stdin: "Ada\n",
      mode: "quick_run",
    })).toThrow(PracticeDispatchSnapshotError);
  });

  it("round-trips one exact bounded request without tests or credential material", () => {
    const snapshot = buildPracticeRunnerRequest({
      admission,
      language: "python",
      runtimeVersion: "Python 3.14",
      entrypoint: "main.py",
      sourceCode,
      stdin: "Ada\n",
      mode: "quick_run",
    });
    const restored = validatePracticeDispatchSnapshot({
      snapshot: JSON.parse(serializeRunnerRequest(snapshot)),
      submissionId: admission.submissionId,
      userId: admission.userId,
      requestId: admission.requestId,
      requestHash: admission.requestHash,
      submissionType: "server_run",
      language: "python",
      sourceCode,
      sourceHash,
    });

    expect(serializeRunnerRequest(restored)).toBe(serializeRunnerRequest(snapshot));
    expect(restored).not.toHaveProperty("tests");
    expect(restored).not.toHaveProperty("testBundleVersion");
    expect(serializeRunnerRequest(restored)).not.toMatch(/api.?key|credential|expectedStdout/i);
  });

  it.each([
    ["different source", { sourceFiles: [{ path: "main.py", content: "print('tampered')" }] }],
    ["different submission", { submissionId: "20000000-0000-4000-8000-000000000002" }],
    ["different stdin", { stdin: "tampered input\n" }],
    ["different runtime", { runtimeVersion: "Python 9.99" }],
    ["hidden tests", { tests: [{ id: "hidden", visibility: "HIDDEN" }] }],
    ["unsafe limits", { limits: { wallTimeMs: 30_000 } }],
  ])("fails closed for %s in a persisted snapshot", (_label, override) => {
    const valid = buildPracticeRunnerRequest({
      admission,
      language: "python",
      runtimeVersion: "Python 3.14",
      entrypoint: "main.py",
      sourceCode,
      stdin: "Ada\n",
      mode: "quick_run",
    });
    expect(() => validatePracticeDispatchSnapshot({
      snapshot: { ...valid, ...override },
      submissionId: admission.submissionId,
      userId: admission.userId,
      requestId: admission.requestId,
      requestHash: admission.requestHash,
      submissionType: "server_run",
      language: "python",
      sourceCode,
      sourceHash,
    })).toThrow(PracticeDispatchSnapshotError);
  });
});
