import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const serviceSource = readFileSync(
  path.resolve(process.cwd(), "src/lib/battles/service.ts"),
  "utf8",
);

function functionBody(start: string, end: string) {
  const startIndex = serviceSource.indexOf(start);
  const endIndex = serviceSource.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return serviceSource.slice(startIndex, endIndex);
}

describe("battle user-authority ordering", () => {
  it("uses an actor-only locked path for an existing exact create replay", () => {
    const create = functionBody(
      "export async function createBattle",
      "async function loadAccessibleBattle",
    );
    const hint = create.indexOf("const initialReplayHint");
    const authorityLocks = create.indexOf(
      "await lockUserAuthorities",
      hint,
    );
    const actorRowLock = create.indexOf(
      "await activeActor(client, input.actorUserId, true)",
      authorityLocks,
    );
    const replayLock = create.indexOf(
      "await lockAndReadCreateReplay",
      actorRowLock,
    );
    const candidateResolution = create.indexOf(
      "const candidates = await resolveCreateUserCandidates",
    );

    expect(hint).toBeGreaterThanOrEqual(0);
    expect(authorityLocks).toBeGreaterThan(hint);
    expect(actorRowLock).toBeGreaterThan(authorityLocks);
    expect(replayLock).toBeGreaterThan(actorRowLock);
    expect(candidateResolution).toBeGreaterThan(replayLock);
    expect(create.slice(hint, candidateResolution)).not.toContain(
      "activeInvitees",
    );
  });

  it("locks every resolved account and row before new-create mutable state", () => {
    const create = functionBody(
      "export async function createBattle",
      "async function loadAccessibleBattle",
    );
    const candidateResolution = create.indexOf(
      "const candidates = await resolveCreateUserCandidates",
    );
    const authorityLocks = create.indexOf(
      "await lockUserAuthorities",
      candidateResolution,
    );
    const postLockReplayHint = create.indexOf(
      "if (await hasCreateReplayHint",
      authorityLocks,
    );
    const userRowLocks = create.indexOf(
      "await lockCreateUserRows",
      postLockReplayHint,
    );
    const createReplayLock = create.indexOf(
      "await lockAndReadCreateReplay",
      userRowLocks,
    );
    const inviteeRevalidation = create.indexOf(
      "await activeInvitees",
      createReplayLock,
    );
    const sourceRead = create.indexOf(
      "await reviewedActivity",
      inviteeRevalidation,
    );
    const battleWrite = create.indexOf(
      "insert into coding_battle",
      sourceRead,
    );

    expect(candidateResolution).toBeGreaterThanOrEqual(0);
    expect(authorityLocks).toBeGreaterThan(candidateResolution);
    expect(postLockReplayHint).toBeGreaterThan(authorityLocks);
    expect(userRowLocks).toBeGreaterThan(postLockReplayHint);
    expect(createReplayLock).toBeGreaterThan(userRowLocks);
    expect(inviteeRevalidation).toBeGreaterThan(createReplayLock);
    expect(sourceRead).toBeGreaterThan(inviteeRevalidation);
    expect(battleWrite).toBeGreaterThan(sourceRead);
  });

  it("locks the request before exact replay requery and fingerprint validation", () => {
    const helper = functionBody(
      "async function lockAndReadCreateReplay",
      "export async function createBattle",
    );
    const requestLock = helper.indexOf("pg_advisory_xact_lock");
    const exactReplayRead = helper.indexOf(
      "select id,create_input_hash from coding_battle",
    );
    const fingerprintValidation = helper.indexOf(
      "replay.create_input_hash !== fingerprint",
    );

    expect(requestLock).toBeGreaterThanOrEqual(0);
    expect(exactReplayRead).toBeGreaterThan(requestLock);
    expect(fingerprintValidation).toBeGreaterThan(exactReplayRead);
  });

  it("sorts distinct internal user IDs before taking canonical authority locks", () => {
    const helper = functionBody(
      "async function lockUserAuthorities",
      "async function activeActor",
    );

    expect(helper).toContain("[...new Set(userIds)].sort()");
    expect(helper).toContain("userAuthorityLockKey(userId)");
    expect(helper).toContain("order by id for update");
    expect(helper.indexOf("[...new Set(userIds)].sort()")).toBeLessThan(
      helper.indexOf("pg_advisory_xact_lock"),
    );
  });

  it("locks and revalidates the joining learner before reading battle or participant state", () => {
    const join = functionBody(
      "export async function joinBattle",
      "export async function submitBattle",
    );
    const authorityLocks = join.indexOf("await lockUserAuthorities");
    const actorRevalidation = join.indexOf("await activeActor(client, input.actorUserId, true)");
    const battleRead = join.indexOf("await loadAccessibleBattle");
    const participantWrite = join.indexOf("insert into coding_battle_participant");

    expect(authorityLocks).toBeGreaterThanOrEqual(0);
    expect(actorRevalidation).toBeGreaterThan(authorityLocks);
    expect(battleRead).toBeGreaterThan(actorRevalidation);
    expect(participantWrite).toBeGreaterThan(battleRead);
  });
});
