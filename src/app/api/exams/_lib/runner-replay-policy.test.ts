import { describe, expect, it } from "vitest";

import {
  examFinalizationRunnerSeed,
  hasExactRunnerTestManifest,
  isIndeterminateRunnerIdentityConflict,
  isUnresolvedActiveRunnerReplay,
  persistRunnerMutationAfterRemote,
  RunnerPersistenceAmbiguityError,
  runnerFailureRequiresReconciliation,
} from "./runner-replay-policy";

describe("exam runner replay policy", () => {
  it.each([
    { status: "leased", remoteJobId: null },
    { status: "running", remoteJobId: null },
    { status: "queued", remoteJobId: "remote-1" },
  ])("preserves an unresolved duplicate admission for $status", ({ status, remoteJobId }) => {
    expect(isUnresolvedActiveRunnerReplay({
      duplicate: true,
      status,
      remoteJobId,
      trustedRemoteResponseReceived: false,
    })).toBe(true);
  });

  it("allows determinate handling before dispatch or after a trusted response", () => {
    expect(isUnresolvedActiveRunnerReplay({
      duplicate: true,
      status: "queued",
      remoteJobId: null,
      trustedRemoteResponseReceived: false,
    })).toBe(false);
    expect(isUnresolvedActiveRunnerReplay({
      duplicate: true,
      status: "running",
      remoteJobId: "remote-1",
      trustedRemoteResponseReceived: true,
    })).toBe(false);
  });

  it("preserves a post-lock remote identity even for a caller admitted as fresh", () => {
    expect(isUnresolvedActiveRunnerReplay({
      duplicate: false,
      status: "queued",
      remoteJobId: "remote-won-by-concurrent-dispatch",
      trustedRemoteResponseReceived: false,
    })).toBe(true);
  });

  it("treats a competing immutable remote identity as indeterminate", () => {
    expect(isIndeterminateRunnerIdentityConflict("REMOTE_JOB_ID_MISMATCH")).toBe(true);
    expect(isIndeterminateRunnerIdentityConflict("WRITE_CONFLICT")).toBe(false);
    expect(isIndeterminateRunnerIdentityConflict(undefined)).toBe(false);
  });

  it.each([
    ["queued response dispatch recording", "remote-queued"],
    ["completed response settlement", "remote-completed"],
  ])("keeps the same remote admission after an injected DB error during %s", async (_phase, remoteJobId) => {
    const databaseError = Object.assign(new Error("connection lost after commit"), { code: "08006" });
    await expect(persistRunnerMutationAfterRemote({
      remoteJobId,
      mutation: async () => { throw databaseError; },
    })).rejects.toMatchObject({
      name: "RunnerPersistenceAmbiguityError",
      remoteJobId,
      cause: databaseError,
    });
  });

  it("preserves explicit admission CAS signals and reconciles every post-remote failure", async () => {
    const terminalReplay = Object.assign(new Error("TERMINAL_REPLAY"), { code: "TERMINAL_REPLAY" });
    await expect(persistRunnerMutationAfterRemote({
      remoteJobId: "remote-1",
      mutation: async () => { throw terminalReplay; },
      preserveError: (error) => error === terminalReplay,
    })).rejects.toBe(terminalReplay);
    expect(runnerFailureRequiresReconciliation({
      trustedRemoteResponseReceived: true,
      remoteJobId: null,
    })).toBe(true);
    expect(runnerFailureRequiresReconciliation({
      trustedRemoteResponseReceived: false,
      remoteJobId: "remote-1",
    })).toBe(true);
    expect(runnerFailureRequiresReconciliation({
      trustedRemoteResponseReceived: false,
      remoteJobId: null,
    })).toBe(false);
    expect(new RunnerPersistenceAmbiguityError("remote-1", terminalReplay).remoteJobId).toBe("remote-1");
  });

  it("keeps the finalization seed stable until a determinate runner generation advances", () => {
    const base = { sessionId: "session-1", itemId: "code-1", revision: 4 };
    const first = examFinalizationRunnerSeed({ ...base, runnerRequestGeneration: 1 });
    expect(examFinalizationRunnerSeed({ ...base, runnerRequestGeneration: 1 })).toBe(first);
    expect(examFinalizationRunnerSeed({ ...base, runnerRequestGeneration: 2 })).not.toBe(first);
    expect(first).toBe("session-1:code-1:final:4:runner-1");
  });

  it("requires an exact runner test manifest and internally consistent totals", () => {
    const expected = [
      { id: "visible", visibility: "VISIBLE", category: "normal" },
      { id: "hidden", visibility: "HIDDEN", category: "boundary" },
    ];
    const observed = {
      tests: [
        { ...expected[0]!, status: "PASSED" },
        { ...expected[1]!, status: "FAILED" },
      ],
      totals: { passed: 1, failed: 1, total: 2 },
    };
    expect(hasExactRunnerTestManifest(expected, observed)).toBe(true);
    expect(hasExactRunnerTestManifest(expected, {
      tests: observed.tests.slice(0, 1), totals: { passed: 1, failed: 0, total: 1 },
    })).toBe(false);
    expect(hasExactRunnerTestManifest(expected, {
      ...observed,
      tests: [observed.tests[0]!, { ...observed.tests[1]!, visibility: "VISIBLE" }],
    })).toBe(false);
    expect(hasExactRunnerTestManifest(expected, {
      ...observed,
      totals: { passed: 2, failed: 0, total: 2 },
    })).toBe(false);
  });
});
