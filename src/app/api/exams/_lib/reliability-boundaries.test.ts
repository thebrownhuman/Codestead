import { readFileSync } from "node:fs";
import path from "node:path";
import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { hasPostgresErrorCode } from "@/lib/db/postgres-errors";

describe("exam reliability source boundaries", () => {
  it("locks and revalidates the effective source result inside mastery-recheck admission", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/api/exams/_lib/service.ts"), "utf8");
    expect(source).toContain("eq(attempt.id, locked.sourceAttemptId)");
    expect(source).toContain(".where(eq(assessmentAttemptEffectiveResult.attemptId, locked.sourceAttemptId))");
    expect(source).toContain(".for(\"update\")");
    expect(source).toContain("sameStringSet(sourceResult.masteryRecheck.clusterIds, locked.targetClusterIds)");
    const serializationFailure = Object.assign(new Error("could not serialize access"), { code: "40001" });
    expect(hasPostgresErrorCode(
      new DrizzleQueryError("insert into attempt", [], serializationFailure),
      "40001",
    )).toBe(true);
  });

  it("ships immutable grant/recheck evidence and terminal state enforcement in migration 0029", () => {
    const migration = readFileSync(path.join(process.cwd(), "drizzle/0029_slow_bulldozer.sql"), "utf8");
    const service = readFileSync(path.join(process.cwd(), "src/app/api/exams/_lib/service.ts"), "utf8");
    const grantService = readFileSync(path.join(process.cwd(), "src/lib/exams/reexam-grant.ts"), "utf8");
    expect(migration).toContain("exam_reexam_grant_state_shape_check");
    expect(migration).toContain("exam_mastery_recheck_state_shape_check");
    expect(migration).toContain("exam_reexam_grant_immutable_guard");
    expect(migration).toContain("exam_mastery_recheck_immutable_guard");
    expect(migration).toContain("NEW.evidence IS DISTINCT FROM OLD.evidence");
    expect(migration).toContain("terminal exam re-exam grant is immutable");
    expect(migration).toContain("completed exam mastery recheck is immutable");
    expect(service).toContain('eq(examMasteryRecheck.status, "active")');
    const moduleLock = grantService.indexOf("exam:${previewRow.user_id}:${previewForm.moduleId}");
    const sourceAttemptLock = grantService.indexOf("for update of es,a");
    expect(moduleLock).toBeGreaterThan(-1);
    expect(sourceAttemptLock).toBeGreaterThan(moduleLock);
  });

  it("persists the runner dispatch boundary and defers official grading for indeterminate outcomes", () => {
    const service = readFileSync(path.join(process.cwd(), "src/app/api/exams/_lib/service.ts"), "utf8");
    const dispatchBoundary = service.indexOf("await beginRunnerDispatch({ admission");
    const immutableRemote = service.indexOf("immutableRemoteJobId = dispatchBoundary.remoteJobId", dispatchBoundary);
    const resumeByGet = service.indexOf("await client.waitForJob(immutableRemoteJobId, request)", immutableRemote);
    const remoteSubmit = service.indexOf("await client.submit(request, idempotencyKey)", dispatchBoundary);
    const waitWithoutResubmit = service.indexOf("await client.waitFrom(submitted, request)", remoteSubmit);
    const terminalGuard = service.indexOf('error.code === "TERMINAL_REPLAY"');
    const indeterminateGuard = service.indexOf("error instanceof RunnerIndeterminateError", remoteSubmit);
    const indeterminateError = service.indexOf('"RUNNER_INDETERMINATE"', indeterminateGuard);
    const failureSettlement = service.indexOf("await settleRunnerJob({", indeterminateError);
    const retryableError = service.indexOf('"RUNNER_CAPACITY_BUSY"', terminalGuard);
    const finalizationRethrow = service.indexOf("if (capacityDeferred || learnerInactive) throw error");
    const grading = service.indexOf("const result = gradeExamSubmission({", finalizationRethrow);

    expect(dispatchBoundary).toBeGreaterThan(-1);
    expect(immutableRemote).toBeGreaterThan(dispatchBoundary);
    expect(resumeByGet).toBeGreaterThan(immutableRemote);
    expect(remoteSubmit).toBeGreaterThan(dispatchBoundary);
    expect(remoteSubmit).toBeGreaterThan(resumeByGet);
    expect(waitWithoutResubmit).toBeGreaterThan(remoteSubmit);
    expect(terminalGuard).toBeGreaterThan(-1);
    expect(indeterminateGuard).toBeGreaterThan(remoteSubmit);
    expect(indeterminateError).toBeGreaterThan(indeterminateGuard);
    expect(failureSettlement).toBeGreaterThan(indeterminateError);
    expect(retryableError).toBeGreaterThan(terminalGuard);
    expect(finalizationRethrow).toBeGreaterThan(retryableError);
    expect(grading).toBeGreaterThan(finalizationRethrow);
    expect(service.match(/error\.code === "USER_NOT_ACTIVE"/g)).toHaveLength(2);
    expect(service).toContain('"LEARNER_NOT_ACTIVE"');
    expect(service).toContain("if (terminalReplay) return reconcileExamRunnerResult(admission, input)");
    expect(service).toContain("expectedRuntimeImageDigest: input.expectedRuntimeImageDigest ?? null");
    expect(service).toContain("examRunnerBindingError(input, result)");
  });

  it("revalidates exact unexpired lease authority before every official projection", () => {
    const service = readFileSync(path.join(process.cwd(), "src/app/api/exams/_lib/service.ts"), "utf8");
    const authority = service.indexOf("async function lockFinalizationAuthority(");
    const ownerFence = service.indexOf("job.leaseOwner !== fence.owner", authority);
    const generationFence = service.indexOf("job.attemptCount !== fence.attemptCount", ownerFence);
    const expiryFence = service.indexOf("job.leaseExpiresAt.getTime() <= checkedAt.getTime()", generationFence);
    const finiteClockFence = service.indexOf("!Number.isFinite(checkedAt.getTime())", authority);
    const finalTransaction = service.indexOf("const persistedResult = await db.transaction", expiryFence);
    const finalFence = service.indexOf("await lockFinalizationAuthority(tx, sessionId, now, options.leaseFence)", finalTransaction);
    const resultInsert = service.indexOf(".insert(examResponse)", finalFence);
    const winningRead = service.indexOf("const winningResult = storedResult", resultInsert);
    const attemptProjection = service.indexOf(".update(attempt)", winningRead);
    const sessionProjection = service.indexOf(".update(examSession)", attemptProjection);

    expect(ownerFence).toBeGreaterThan(authority);
    expect(finiteClockFence).toBeGreaterThan(authority);
    expect(finiteClockFence).toBeLessThan(ownerFence);
    expect(generationFence).toBeGreaterThan(ownerFence);
    expect(expiryFence).toBeGreaterThan(generationFence);
    expect(finalFence).toBeGreaterThan(finalTransaction);
    expect(resultInsert).toBeGreaterThan(finalFence);
    expect(winningRead).toBeGreaterThan(resultInsert);
    expect(attemptProjection).toBeGreaterThan(winningRead);
    expect(sessionProjection).toBeGreaterThan(attemptProjection);
    expect(service).toContain("runnerRequestGeneration: job?.runnerRequestGeneration ?? 1");
    expect(service).toContain("idempotencySeed: examFinalizationRunnerSeed({");
  });

  it("keeps post-remote DB ambiguity on the same admission before any fallback settlement", () => {
    const service = readFileSync(path.join(process.cwd(), "src/app/api/exams/_lib/service.ts"), "utf8");
    const firstPersistenceBoundary = service.indexOf("await persistRunnerMutationAfterRemote({");
    const reconciliationGuard = service.indexOf("runnerFailureRequiresReconciliation({", firstPersistenceBoundary);
    const fallbackSettlement = service.indexOf("await settleRunnerJob({", reconciliationGuard);

    expect(service.match(/await persistRunnerMutationAfterRemote\(\{/g)).toHaveLength(3);
    expect(firstPersistenceBoundary).toBeGreaterThan(-1);
    expect(reconciliationGuard).toBeGreaterThan(firstPersistenceBoundary);
    expect(fallbackSettlement).toBeGreaterThan(reconciliationGuard);
    expect(service).toContain("The terminal runner admission could not be reconciled yet.");
  });

  it("acquires user authority and rechecks active status before every official write or projection", () => {
    const service = readFileSync(path.join(process.cwd(), "src/app/api/exams/_lib/service.ts"), "utf8");
    const mastery = readFileSync(path.join(process.cwd(), "src/lib/achievements/exam-mastery.ts"), "utf8");
    const activeHelper = service.indexOf("async function lockActiveOfficialExamUser");
    const globalLock = service.indexOf("await lockUserAuthority(tx, userId)", activeHelper);
    const activeCheck = service.indexOf('account?.status !== "active"', globalLock);
    const claim = service.indexOf("async function claimFinalization(");
    const claimAuthority = service.indexOf("await lockActiveOfficialExamUser(tx, userId)", claim);
    const claimJobLock = service.indexOf("await lockFinalizationAuthority(tx, sessionId", claimAuthority);
    const finalTransaction = service.indexOf("const persistedResult = await db.transaction");
    const finalAuthority = service.indexOf("await lockActiveOfficialExamUser(tx, userId)", finalTransaction);
    const finalJobLock = service.indexOf("await lockFinalizationAuthority(tx, sessionId", finalAuthority);

    expect(globalLock).toBeGreaterThan(activeHelper);
    expect(activeCheck).toBeGreaterThan(globalLock);
    expect(claimAuthority).toBeGreaterThan(claim);
    expect(claimJobLock).toBeGreaterThan(claimAuthority);
    expect(finalAuthority).toBeGreaterThan(finalTransaction);
    expect(finalJobLock).toBeGreaterThan(finalAuthority);
    expect(service.match(/await lockActiveOfficialExamUser\(tx,/g)).toHaveLength(6);

    const masteryTransaction = mastery.indexOf("return db.transaction(async (tx)");
    const masteryAuthority = mastery.indexOf("await lockUserAuthority(tx, input.userId)", masteryTransaction);
    const masteryActive = mastery.indexOf('learner?.status !== "active"', masteryAuthority);
    const badgeInsert = mastery.indexOf(".insert(userAchievement)", masteryActive);
    const notificationInsert = mastery.indexOf("tx.insert(notification)", badgeInsert);
    const emailInsert = mastery.indexOf("enqueueEmailInTransaction(tx", notificationInsert);
    expect(masteryAuthority).toBeGreaterThan(masteryTransaction);
    expect(masteryActive).toBeGreaterThan(masteryAuthority);
    expect(badgeInsert).toBeGreaterThan(masteryActive);
    expect(notificationInsert).toBeGreaterThan(badgeInsert);
    expect(emailInsert).toBeGreaterThan(notificationInsert);
    expect(mastery).not.toContain("enqueueEmail(");
  });
});
