import { beforeEach, describe, expect, it, vi } from "vitest";

import { runRunnerPowerRehearsalCli } from "./runner-power-rehearsal-cli";

const ACTOR = "admin-internal-1";
const LEARNER_ONE = "learner-internal-1";
const LEARNER_TWO = "learner-internal-2";
const EVENT = "10000000-0000-4000-8000-000000000001";
const COMMAND = "20000000-0000-4000-8000-000000000002";
const REASON = "Supervised physical power-loss recovery rehearsal for the pilot release.";

function harness(overrides: { uid?: number; euid?: number; platform?: NodeJS.Platform; nodeEnv?: string } = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const controller = {
    arm: vi.fn(async () => ({ eventId: EVENT, state: "armed", replayed: false })),
    status: vi.fn(async () => ({ eventId: EVENT, state: "filled", slotOne: { requestId: "safe-request" } })),
    release: vi.fn(async () => ({ eventId: EVENT, state: "released", recoveryJobsMadeDue: 2 })),
    abort: vi.fn(async () => ({ eventId: EVENT, state: "aborted", recoveryJobsMadeDue: 1, successfulRehearsal: false })),
  };
  return {
    controller,
    output,
    errors,
    options: {
      controller,
      runtime: {
        uid: overrides.uid ?? 0,
        euid: overrides.euid ?? 0,
        platform: overrides.platform ?? "linux" as NodeJS.Platform,
        nodeEnv: overrides.nodeEnv ?? "production",
      },
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    },
  };
}

describe("root-only runner power-rehearsal CLI", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["non-root uid", { uid: 1000 }],
    ["non-root effective uid", { euid: 1000 }],
    ["non-Linux runtime", { platform: "win32" as NodeJS.Platform }],
    ["non-production runtime", { nodeEnv: "development" }],
  ])("fails before database access for %s", async (_label, runtime) => {
    const h = harness(runtime);
    const code = await runRunnerPowerRehearsalCli(["status", "--actor-id", ACTOR, "--event-id", EVENT], h.options);
    expect(code).toBe(77);
    expect(h.controller.status).not.toHaveBeenCalled();
    expect(h.errors.join("\n")).toContain("ROOT_PRODUCTION_RUNTIME_REQUIRED");
  });

  it("parses an arm command without echoing reason or identities beyond safe controller output", async () => {
    const h = harness();
    const code = await runRunnerPowerRehearsalCli([
      "arm",
      "--actor-id", ACTOR,
      "--event-id", EVENT,
      "--learner-one-id", LEARNER_ONE,
      "--learner-two-id", LEARNER_TWO,
      "--reason", REASON,
      "--expires-in-minutes", "30",
    ], h.options);
    expect(code).toBe(0);
    expect(h.controller.arm).toHaveBeenCalledWith({
      actorUserId: ACTOR,
      eventId: EVENT,
      learnerOneId: LEARNER_ONE,
      learnerTwoId: LEARNER_TWO,
      reason: REASON,
      expiresInMinutes: 30,
    });
    expect(h.output).toEqual([JSON.stringify({ eventId: EVENT, state: "armed", replayed: false })]);
    expect(h.output.join("\n")).not.toContain(REASON);
    expect(h.errors).toEqual([]);
  });

  it.each(["release", "abort"] as const)("parses %s with an idempotency command UUID", async (action) => {
    const h = harness();
    const code = await runRunnerPowerRehearsalCli([
      action,
      "--actor-id", ACTOR,
      "--event-id", EVENT,
      "--command-id", COMMAND,
      "--reason", REASON,
    ], h.options);
    expect(code).toBe(0);
    expect(h.controller[action]).toHaveBeenCalledWith({
      actorUserId: ACTOR,
      eventId: EVENT,
      commandId: COMMAND,
      reason: REASON,
    });
  });

  it("parses safe status and does not accept fields that could expose source or credentials", async () => {
    const h = harness();
    const code = await runRunnerPowerRehearsalCli([
      "status", "--actor-id", ACTOR, "--event-id", EVENT,
    ], h.options);
    expect(code).toBe(0);
    expect(h.controller.status).toHaveBeenCalledWith({ actorUserId: ACTOR, eventId: EVENT });
    const serialized = h.output.join("\n");
    expect(serialized).not.toMatch(/email|reason|source|api.?key|secret|token|password|credential/i);
  });

  it.each([
    [[]],
    [["unknown"]],
    [["status", "--actor-id", ACTOR]],
    [["arm", "--actor-id", ACTOR, "--event-id", EVENT, "--learner-one-id", LEARNER_ONE]],
    [["release", "--actor-id", ACTOR, "--event-id", EVENT, "--command-id", COMMAND]],
    [["abort", "--actor-id", ACTOR, "--event-id", EVENT, "--command-id", COMMAND, "--reason", REASON, "--extra", "bad"]],
  ])("rejects malformed arguments without calling the controller: %#", async (argv) => {
    const h = harness();
    const code = await runRunnerPowerRehearsalCli(argv, h.options);
    expect(code).toBe(64);
    expect(h.controller.arm).not.toHaveBeenCalled();
    expect(h.controller.status).not.toHaveBeenCalled();
    expect(h.controller.release).not.toHaveBeenCalled();
    expect(h.controller.abort).not.toHaveBeenCalled();
    expect(h.errors.join("\n")).toContain("INVALID_ARGUMENTS");
  });

  it("maps controller failures to a safe code without reflecting attacker input", async () => {
    const h = harness();
    h.controller.arm.mockRejectedValueOnce(Object.assign(new Error("secret reason should never escape"), { code: "ADMIN_REQUIRED" }));
    const code = await runRunnerPowerRehearsalCli([
      "arm",
      "--actor-id", ACTOR,
      "--event-id", EVENT,
      "--learner-one-id", LEARNER_ONE,
      "--learner-two-id", LEARNER_TWO,
      "--reason", REASON,
      "--expires-in-minutes", "30",
    ], h.options);
    expect(code).toBe(1);
    expect(h.errors).toEqual([JSON.stringify({ event: "runner_power_rehearsal_control.failed", code: "ADMIN_REQUIRED" })]);
    expect(h.errors.join("\n")).not.toContain(REASON);
    expect(h.errors.join("\n")).not.toContain("secret reason");
  });
});
