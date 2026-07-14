import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const onConflictDoNothing = vi.fn();
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  return { limit, select, values, insert, onConflictDoNothing };
});

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select, insert: mocks.insert } }));

import { gateClosedBookCapability } from "../capability-gate";

describe("server-authoritative closed-book capability gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limit.mockResolvedValue([]);
    mocks.onConflictDoNothing.mockResolvedValue(undefined);
  });

  it.each([
    "ai_tutor",
    "general_code_runner",
    "practice_game",
    "learner_files",
    "project_workspace",
    "learning_workspace",
  ] as const)(
    "allows %s only when no active or system-paused exam exists",
    async (capability) => {
      await expect(gateClosedBookCapability("learner-1", capability)).resolves.toEqual({ allowed: true });
      mocks.limit.mockResolvedValueOnce([{ id: "exam-1", status: "active" }]);
      await expect(gateClosedBookCapability("learner-1", capability)).resolves.toMatchObject({
        allowed: false,
        code: "EXAM_CLOSED_BOOK",
        status: 423,
      });
      mocks.limit.mockResolvedValueOnce([{ id: "exam-1", status: "paused_by_system" }]);
      await expect(gateClosedBookCapability("learner-1", capability)).resolves.toMatchObject({
        allowed: false,
        code: "EXAM_CLOSED_BOOK",
      });
      expect(mocks.values).toHaveBeenLastCalledWith(expect.objectContaining({
        examSessionId: "exam-1",
        clientEventId: expect.stringMatching(`^blocked-capability:${capability}:[0-9]+$`),
        type: "blocked_capability_attempt",
        metadata: { capability },
      }));
      expect(mocks.onConflictDoNothing).toHaveBeenCalled();
    },
  );

  it("fails closed when authoritative exam state cannot be read", async () => {
    mocks.limit.mockRejectedValueOnce(new Error("database unavailable"));
    const decision = await gateClosedBookCapability("learner-1", "ai_tutor");
    expect(decision).toMatchObject({
      allowed: false,
      code: "EXAM_STATE_UNAVAILABLE",
      status: 503,
    });
    expect(JSON.stringify(decision)).not.toContain("database unavailable");
  });

  it("fails closed if the blocked capability attempt cannot be recorded", async () => {
    mocks.limit.mockResolvedValueOnce([{ id: "exam-1", status: "active" }]);
    mocks.onConflictDoNothing.mockRejectedValueOnce(new Error("event store unavailable"));
    await expect(gateClosedBookCapability("learner-1", "learner_files")).resolves.toMatchObject({
      allowed: false,
      code: "EXAM_STATE_UNAVAILABLE",
      status: 503,
    });
  });

  it("keeps every help-capable route wired to the server gate", () => {
    const routes = {
      "src/app/api/ai/tutor/route.ts": 'gateClosedBookCapability(authz.session.user.id, "ai_tutor")',
      "src/app/api/code/run/route.ts": 'gateClosedBookCapability(authz.session.user.id, "general_code_runner")',
      "src/app/api/games/check/route.ts": 'gateClosedBookCapability(authz.session.user.id, "practice_game")',
    };
    for (const [file, requiredCall] of Object.entries(routes)) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source).toContain(requiredCall);
      expect(source).toContain("examGate.code");
    }
  });

  it("marks file, project, and learning APIs as closed-book capabilities", () => {
    const routes: Readonly<Record<string, string>> = {
      "src/app/api/ai/reports/route.ts": 'closedBookCapability: "ai_tutor"',
      "src/app/api/files/route.ts": 'closedBookCapability: "learner_files"',
      "src/app/api/files/[id]/route.ts": 'closedBookCapability: "learner_files"',
      "src/app/api/projects/route.ts": 'closedBookCapability: "project_workspace"',
      "src/app/api/projects/[id]/review/route.ts": 'closedBookCapability: "project_workspace"',
      "src/app/api/projects/[id]/reviews/[reviewId]/appeal/route.ts": 'closedBookCapability: "project_workspace"',
      "src/app/api/learning/attempts/route.ts": 'closedBookCapability: "learning_workspace"',
      "src/app/api/learning/attempts/[attemptId]/submit/route.ts": 'closedBookCapability: "learning_workspace"',
      "src/app/api/learning/dsa/language/route.ts": 'closedBookCapability: "learning_workspace"',
      "src/app/api/learning/next/route.ts": 'closedBookCapability: "learning_workspace"',
      "src/app/api/learning/placement/route.ts": 'closedBookCapability: "learning_workspace"',
      "src/app/api/learning/plans/route.ts": 'closedBookCapability: "learning_workspace"',
      "src/app/api/learning/sessions/route.ts": 'closedBookCapability: "learning_workspace"',
      "src/app/api/learning/sessions/[sessionId]/events/route.ts": 'closedBookCapability: "learning_workspace"',
      "src/app/api/learning/sessions/[sessionId]/route.ts": 'closedBookCapability: "learning_workspace"',
      "src/app/api/drafts/route.ts": 'closedBookCapability: "learning_workspace"',
    };
    for (const [file, marker] of Object.entries(routes)) {
      expect(readFileSync(path.join(process.cwd(), file), "utf8"), file).toContain(marker);
    }
  });
});
