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
  it("locks the actor and resolved invitees before create replay, source, or battle state", () => {
    const create = functionBody(
      "export async function createBattle",
      "async function loadAccessibleBattle",
    );
    const candidateResolution = create.indexOf("resolveCreateUserCandidates");
    const authorityLocks = create.indexOf("await lockUserAuthorities");
    const userRowLocks = create.indexOf("await lockCreateUserRows");
    const inviteeRevalidation = create.indexOf("await activeInvitees");
    const createReplayLock = create.indexOf("battle-create:");
    const sourceRead = create.indexOf("await reviewedActivity");
    const battleWrite = create.indexOf("insert into coding_battle");

    expect(candidateResolution).toBeGreaterThanOrEqual(0);
    expect(authorityLocks).toBeGreaterThan(candidateResolution);
    expect(userRowLocks).toBeGreaterThan(authorityLocks);
    expect(inviteeRevalidation).toBeGreaterThan(userRowLocks);
    expect(createReplayLock).toBeGreaterThan(inviteeRevalidation);
    expect(sourceRead).toBeGreaterThan(createReplayLock);
    expect(battleWrite).toBeGreaterThan(sourceRead);
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
