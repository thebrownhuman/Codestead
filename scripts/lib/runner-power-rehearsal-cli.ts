import { parseArgs } from "node:util";

import {
  abortRunnerPowerRehearsal,
  armRunnerPowerRehearsal,
  getRunnerPowerRehearsalStatus,
  releaseRunnerPowerRehearsal,
} from "../../src/lib/runner/power-rehearsal-admin";

type Controller = Readonly<{
  arm(input: {
    actorUserId: string;
    eventId: string;
    learnerOneId: string;
    learnerTwoId: string;
    reason: string;
    expiresInMinutes: number;
  }): Promise<unknown>;
  status(input: { actorUserId: string; eventId: string }): Promise<unknown>;
  release(input: {
    actorUserId: string;
    eventId: string;
    commandId: string;
    reason: string;
  }): Promise<unknown>;
  abort(input: {
    actorUserId: string;
    eventId: string;
    commandId: string;
    reason: string;
  }): Promise<unknown>;
}>;

type Runtime = Readonly<{
  uid: number | undefined;
  euid: number | undefined;
  platform: NodeJS.Platform;
  nodeEnv: string | undefined;
}>;

export type RunnerPowerRehearsalCliOptions = Readonly<{
  controller?: Controller;
  runtime?: Runtime;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}>;

const defaultController: Controller = {
  arm: armRunnerPowerRehearsal,
  status: getRunnerPowerRehearsalStatus,
  release: releaseRunnerPowerRehearsal,
  abort: abortRunnerPowerRehearsal,
};

function currentRuntime(): Runtime {
  return {
    uid: process.getuid?.(),
    euid: process.geteuid?.(),
    platform: process.platform,
    nodeEnv: process.env.NODE_ENV,
  };
}

function required(value: string | undefined) {
  if (!value) throw new Error("INVALID_ARGUMENTS");
  return value;
}

function rejectUnexpected(values: Record<string, string | boolean | undefined>, allowed: string[]) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && !allowed.includes(key)) throw new Error("INVALID_ARGUMENTS");
  }
}

function safeErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
  }
  return "INTERNAL_ERROR";
}

export async function runRunnerPowerRehearsalCli(
  argv: string[],
  options: RunnerPowerRehearsalCliOptions = {},
) {
  const stdout = options.stdout ?? ((line: string) => console.info(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const runtime = options.runtime ?? currentRuntime();
  const controller = options.controller ?? defaultController;
  if (runtime.platform !== "linux" || runtime.uid !== 0 || runtime.euid !== 0 || runtime.nodeEnv !== "production") {
    stderr(JSON.stringify({ event: "runner_power_rehearsal_control.failed", code: "ROOT_PRODUCTION_RUNTIME_REQUIRED" }));
    return 77;
  }

  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        "actor-id": { type: "string" },
        "event-id": { type: "string" },
        "learner-one-id": { type: "string" },
        "learner-two-id": { type: "string" },
        "command-id": { type: "string" },
        reason: { type: "string" },
        "expires-in-minutes": { type: "string" },
      },
    });
    if (parsed.positionals.length !== 1) throw new Error("INVALID_ARGUMENTS");
    const action = parsed.positionals[0];
    const values = parsed.values as Record<string, string | boolean | undefined>;
    const actorUserId = required(values["actor-id"] as string | undefined);
    const eventId = required(values["event-id"] as string | undefined);
    let result: unknown;
    if (action === "status") {
      rejectUnexpected(values, ["actor-id", "event-id"]);
      result = await controller.status({ actorUserId, eventId });
    } else if (action === "arm") {
      rejectUnexpected(values, ["actor-id", "event-id", "learner-one-id", "learner-two-id", "reason", "expires-in-minutes"]);
      const expiresInMinutes = Number(required(values["expires-in-minutes"] as string | undefined));
      result = await controller.arm({
        actorUserId,
        eventId,
        learnerOneId: required(values["learner-one-id"] as string | undefined),
        learnerTwoId: required(values["learner-two-id"] as string | undefined),
        reason: required(values.reason as string | undefined),
        expiresInMinutes,
      });
    } else if (action === "release" || action === "abort") {
      rejectUnexpected(values, ["actor-id", "event-id", "command-id", "reason"]);
      result = await controller[action]({
        actorUserId,
        eventId,
        commandId: required(values["command-id"] as string | undefined),
        reason: required(values.reason as string | undefined),
      });
    } else {
      throw new Error("INVALID_ARGUMENTS");
    }
    stdout(JSON.stringify(result));
    return 0;
  } catch (error) {
    const parserRejected = error && typeof error === "object" && "code" in error
      && typeof (error as { code?: unknown }).code === "string"
      && (error as { code: string }).code.startsWith("ERR_PARSE_ARGS");
    const code = parserRejected || (error instanceof Error && error.message === "INVALID_ARGUMENTS")
      ? "INVALID_ARGUMENTS"
      : safeErrorCode(error);
    stderr(JSON.stringify({ event: "runner_power_rehearsal_control.failed", code }));
    return code === "INVALID_ARGUMENTS" ? 64 : 1;
  }
}
