import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { PRODUCTION_LOAD_FAULT_MATRIX } from "../../src/lib/performance/load-report";
import {
  createProductionLoadLinuxIsolationBackend,
  type ProductionLoadLinuxCommand,
  type ProductionLoadLinuxCommandExecutor,
  type ProductionLoadLinuxCommandResult,
  type ProductionLoadLinuxPathIdentity,
} from "./production-load-linux-backend";

const VM_ID = "57b9ab11-f3a4-4ea8-a58e-e73d951f9d11";
const VM_MAC = "52:54:00:20:00:12";
const CONTROL = "/opt/learncoding/infra/ops/production-load-control.py";
const BROWSER = "/opt/learncoding/infra/ops/production-load-browser-journey.py";
const NOW = "2026-07-20T12:00:00.000Z";
const MAX_OUTPUT_BYTES = 64 * 1024;

const serviceTargets = {
  app_container_restart: "app",
  email_worker_restart: "mail-worker",
  assessment_regrade_worker_restart: "regrade-worker",
  project_review_correction_worker_restart: "project-review-correction-worker",
  exam_finalization_worker_restart: "exam-finalization-worker",
  practice_recovery_worker_restart: "practice-runner-recovery-worker",
  rewards_worker_restart: "reward-worker",
} as const;

const testControlFaults = [
  "postgres_proxy_interruption",
  "tunnel_proxy_interruption",
  "fake_gmail_failure",
  "fake_ai_provider_failure",
  "fake_offsite_drive_failure",
  "quota_volume_near_full",
  "synthetic_stale_backup_alert",
] as const;

const hostTelemetry = {
  hostCpuPercent: 12.5,
  availableMemoryBytes: 16 * 1024 ** 3,
  rootFreeFraction: 0.42,
  rootFreeBytes: 420_000_000_000,
  diskReadBytes: 1234,
  diskWriteBytes: 5678,
  temperatureCelsius: 54.5,
  oomKills: 0,
  thermalThrottleIncrements: 0,
};

const runnerTelemetry = {
  runnerVmCpuPercent: 21.25,
  runnerVmAvailableMemoryBytes: 4 * 1024 ** 3,
};

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

function canonical(value: unknown): Uint8Array {
  return bytes(`${JSON.stringify(value)}\n`);
}

function success(stdout: Uint8Array = bytes("")): ProductionLoadLinuxCommandResult {
  return { exitCode: 0, stdout, stderr: bytes(""), timedOut: false };
}

const composeContainer = {
  ID: "a".repeat(64),
  Names: "learncoding-app-1",
  Labels: "com.docker.compose.project=learncoding,com.docker.compose.service=app",
  State: "running",
  Status: "Up 10 minutes (healthy)",
};
const unrelatedContainer = {
  ID: "b".repeat(64),
  Names: "homeassistant",
  Labels: "com.docker.compose.project=homeautomation",
  State: "running",
  Status: "Up 2 hours (healthy)",
};

function inventory(...items: readonly object[]): Uint8Array {
  return bytes(items.map((item) => JSON.stringify(item)).join("\n") + "\n");
}

type FakeExecutor = {
  readonly commands: ProductionLoadLinuxCommand[];
  readonly execute: ProductionLoadLinuxCommandExecutor;
};

function commandFixture(
  override?: (
    command: ProductionLoadLinuxCommand,
    normal: ProductionLoadLinuxCommandResult,
  ) => ProductionLoadLinuxCommandResult | Promise<ProductionLoadLinuxCommandResult>,
): FakeExecutor {
  const commands: ProductionLoadLinuxCommand[] = [];
  const execute: ProductionLoadLinuxCommandExecutor = async (command) => {
    commands.push(command);
    let normal: ProductionLoadLinuxCommandResult;
    if (command.executable === "/usr/bin/virsh"
      && command.args.join("\0")
        === ["--connect", "qemu:///system", "domuuid", "codestead-runner"].join("\0")) {
      normal = success(bytes(`${VM_ID}\n`));
    } else if (command.executable === "/usr/bin/virsh"
      && command.args.join("\0")
        === ["--connect", "qemu:///system", "domiflist", "codestead-runner"].join("\0")) {
      normal = success(bytes(
        ` Interface   Type      Source              Model    MAC\n`
        + `---------------------------------------------------------------\n`
        + ` vnet7       network   default            virtio   ${VM_MAC}\n`,
      ));
    } else if (command.executable === "/usr/bin/docker" && command.args[0] === "ps") {
      normal = success(inventory(composeContainer, unrelatedContainer));
    } else if (command.executable === CONTROL && command.args[0] === "isolation-status") {
      normal = success(canonical({
        maintenanceWindowApproved: true,
        freshRecoveryPoint: true,
      }));
    } else if (command.executable === CONTROL && command.args[0] === "host-telemetry") {
      normal = success(canonical(hostTelemetry));
    } else if (command.executable === CONTROL && command.args[0] === "runner-vm-telemetry") {
      normal = success(canonical(runnerTelemetry));
    } else if (command.executable === CONTROL && command.args[0] === "probe") {
      normal = success(canonical({
        componentHealthy: true,
        alertOrDeadLetterVisible: false,
      }));
    } else if (command.executable === CONTROL && command.args[0] === "invariant-evidence") {
      normal = success(canonical({
        observedAt: NOW,
        acknowledgedMutationFailures: 0,
        runnerMaxConcurrentJobs: 2,
        secretLeakFindings: 0,
      }));
    } else if (command.executable === BROWSER) {
      const faultId = command.args[1];
      const stage = command.args[3];
      normal = success(canonical({ ok: true, faultId, stage }));
    } else {
      normal = success();
    }
    return override ? override(command, normal) : normal;
  };
  return { commands, execute };
}

function trustedIdentity(
  target: string,
  override: Partial<ProductionLoadLinuxPathIdentity> = {},
): ProductionLoadLinuxPathIdentity {
  const isFile = ["/usr/bin/docker", "/usr/bin/virsh", CONTROL, BROWSER].includes(target);
  return {
    kind: isFile ? "file" : "directory",
    uid: 0,
    mode: isFile ? 0o755 : 0o755,
    linkCount: 1,
    ...override,
  };
}

function setup(input: {
  readonly executor?: FakeExecutor;
  readonly platform?: NodeJS.Platform;
  readonly inspectPath?: (target: string) => Promise<ProductionLoadLinuxPathIdentity>;
  readonly controlExecutable?: string;
  readonly browserJourneyExecutable?: string;
  readonly expectedRunnerVmId?: string;
} = {}) {
  const executor = input.executor ?? commandFixture();
  const backend = createProductionLoadLinuxIsolationBackend({
    expectedRunnerVmId: input.expectedRunnerVmId ?? VM_ID,
    controlExecutable: input.controlExecutable ?? CONTROL,
    browserJourneyExecutable: input.browserJourneyExecutable ?? BROWSER,
    executor: executor.execute,
    inspectPath: input.inspectPath ?? (async (target) => trustedIdentity(target)),
    platform: input.platform ?? "linux",
    now: () => new Date(NOW),
  });
  return { backend, executor };
}

function expectedServiceArgs(operation: "restart" | "start", service: string): readonly string[] {
  const prefix = [
    "compose",
    "--project-name", "learncoding",
    "--project-directory", "/opt/learncoding",
    "--file", "/opt/learncoding/compose.yaml",
  ];
  return operation === "restart"
    ? [...prefix, "restart", "--no-deps", service]
    : [...prefix, "start", service];
}

describe("production load Linux backend configuration boundary", () => {
  it("fails closed outside Linux before executing anything", async () => {
    const setupResult = setup({ platform: "win32" });

    await expect(setupResult.backend.inspectIsolation()).rejects.toThrow(/linux_only/);

    expect(setupResult.executor.commands).toEqual([]);
  });

  it.each([
    ["invalid VM UUID", { expectedRunnerVmId: "not-a-uuid" }],
    ["control outside repository", { controlExecutable: "/tmp/control" }],
    ["browser outside repository", { browserJourneyExecutable: "/usr/bin/browser" }],
    ["shell punctuation", { controlExecutable: "/opt/learncoding/infra/ops/control;reboot" }],
  ])("rejects %s synchronously", (_label, override) => {
    expect(() => setup(override)).toThrow(/invalid_configuration/);
  });

  it.each([
    ["symbolic link", { kind: "symbolic-link" as const }],
    ["wrong owner", { uid: 1000 }],
    ["writable executable", { mode: 0o777 }],
    ["multiple links", { linkCount: 2 }],
    ["non-file executable", { kind: "directory" as const }],
  ])("refuses a trusted executable with %s metadata before execution", async (_label, drift) => {
    const setupResult = setup({
      inspectPath: async (target) => target === CONTROL
        ? trustedIdentity(target, drift)
        : trustedIdentity(target),
    });

    await expect(setupResult.backend.captureHost()).rejects.toThrow(/unsafe_executable/);

    expect(setupResult.executor.commands).toEqual([]);
  });

  it("refuses a symbolic-link parent component before execution", async () => {
    const setupResult = setup({
      inspectPath: async (target) => target === "/opt/learncoding"
        ? trustedIdentity(target, { kind: "symbolic-link" })
        : trustedIdentity(target),
    });

    await expect(setupResult.backend.captureHost()).rejects.toThrow(/unsafe_executable/);

    expect(setupResult.executor.commands).toEqual([]);
  });

  it("refuses an unsafe exact workdir before Docker inventory", async () => {
    const setupResult = setup({
      inspectPath: async (target) => target === "/opt/learncoding"
        ? trustedIdentity(target, { kind: "symbolic-link" })
        : trustedIdentity(target),
    });

    await expect(setupResult.backend.unrelatedServicesHealthy(
      "learncoding",
    )).rejects.toThrow(/unsafe_executable/);

    expect(setupResult.executor.commands).toEqual([]);
  });
});

describe("production load Linux isolation and telemetry", () => {
  it("returns the exact project, repository, runner identity, approval, and stable unrelated digest", async () => {
    const setupResult = setup();
    const expectedInventory = [{ id: "b".repeat(64), name: "homeassistant" }];

    await expect(setupResult.backend.inspectIsolation()).resolves.toEqual({
      composeProject: "learncoding",
      runnerVmId: VM_ID,
      runnerVmMac: VM_MAC,
      repositoryRoot: "/opt/learncoding",
      runnerStateRoot: "/var/lib/learncoding-runner",
      maintenanceWindowApproved: true,
      freshRecoveryPoint: true,
      unrelatedInventorySha256: createHash("sha256")
        .update(JSON.stringify(expectedInventory))
        .digest("hex"),
    });
    expect(setupResult.executor.commands[0]).toMatchObject({
      executable: "/usr/bin/virsh",
      args: ["--connect", "qemu:///system", "domuuid", "codestead-runner"],
    });
    expect(setupResult.executor.commands[1]).toMatchObject({
      executable: "/usr/bin/virsh",
      args: ["--connect", "qemu:///system", "domiflist", "codestead-runner"],
    });
  });

  it("makes the unrelated inventory digest independent of command order and changing status age", async () => {
    const first = setup();
    const changed = {
      ...unrelatedContainer,
      Status: "Up 9 hours (healthy)",
    };
    const second = setup({ executor: commandFixture((command, normal) =>
      command.executable === "/usr/bin/docker" && command.args[0] === "ps"
        ? success(inventory(changed, composeContainer))
        : normal) });

    const [left, right] = await Promise.all([
      first.backend.inspectIsolation(),
      second.backend.inspectIsolation(),
    ]);

    expect(left.unrelatedInventorySha256).toBe(right.unrelatedInventorySha256);
  });

  it.each([
    ["runner UUID", (command: ProductionLoadLinuxCommand) =>
      command.executable === "/usr/bin/virsh" && command.args[2] === "domuuid",
    bytes(`${"1".repeat(8)}-${"2".repeat(4)}-4333-a444-${"5".repeat(12)}\n`)],
    ["runner MAC", (command: ProductionLoadLinuxCommand) =>
      command.executable === "/usr/bin/virsh" && command.args[2] === "domiflist",
    bytes(" Interface Type Source Model MAC\n-----\nvnet7 network default virtio 52:54:00:00:00:01\n")],
    ["runner network", (command: ProductionLoadLinuxCommand) =>
      command.executable === "/usr/bin/virsh" && command.args[2] === "domiflist",
    bytes(` Interface Type Source Model MAC\n-----\nvnet7 network codestead-runner virtio ${VM_MAC}\n`)],
    ["Docker inventory", (command: ProductionLoadLinuxCommand) =>
      command.executable === "/usr/bin/docker" && command.args[0] === "ps",
    bytes("not-json\n")],
    ["approval status", (command: ProductionLoadLinuxCommand) =>
      command.executable === CONTROL && command.args[0] === "isolation-status",
    canonical({ maintenanceWindowApproved: true, freshRecoveryPoint: true, extra: true })],
  ] as const)("fails closed on malformed or drifting %s output", async (_label, matches, output) => {
    const setupResult = setup({ executor: commandFixture((command, normal) =>
      matches(command) ? success(output) : normal) });

    await expect(setupResult.backend.inspectIsolation()).rejects.toThrow(/invalid_output/);
  });

  it("parses bounded exact host telemetry", async () => {
    const setupResult = setup();

    await expect(setupResult.backend.captureHost()).resolves.toEqual(hostTelemetry);
  });

  it.each([
    canonical({ ...hostTelemetry, hostCpuPercent: 101 }),
    canonical({ ...hostTelemetry, rootFreeFraction: -0.1 }),
    canonical({ ...hostTelemetry, secretLog: "token" }),
    bytes("{}\n"),
  ])("rejects malformed host telemetry", async (output) => {
    const setupResult = setup({ executor: commandFixture((command, normal) =>
      command.executable === CONTROL && command.args[0] === "host-telemetry"
        ? success(output)
        : normal) });

    await expect(setupResult.backend.captureHost()).rejects.toThrow(/invalid_output/);
  });

  it("parses VM telemetry only for the exact configured UUID", async () => {
    const setupResult = setup();

    await expect(setupResult.backend.captureRunnerVm(VM_ID)).resolves.toEqual(runnerTelemetry);
    await expect(setupResult.backend.captureRunnerVm(
      "123e4567-e89b-42d3-a456-426614174000",
    )).rejects.toThrow(/identity_mismatch/);
  });

  it("returns false for an explicitly unhealthy unrelated container without mutating it", async () => {
    const unhealthy = { ...unrelatedContainer, Status: "Up 2 hours (unhealthy)" };
    const setupResult = setup({ executor: commandFixture((command, normal) =>
      command.executable === "/usr/bin/docker" && command.args[0] === "ps"
        ? success(inventory(composeContainer, unhealthy))
        : normal) });

    await expect(setupResult.backend.unrelatedServicesHealthy("learncoding")).resolves.toBe(false);

    expect(setupResult.executor.commands).toHaveLength(1);
    expect(setupResult.executor.commands[0]?.args[0]).toBe("ps");
  });
});

describe("production load Linux fault allowlists", () => {
  it.each(PRODUCTION_LOAD_FAULT_MATRIX.map((fault) => [fault.id] as const))(
    "maps %s to exactly one allowlisted injection command",
    async (faultId) => {
      const setupResult = setup();

      await setupResult.backend.injectAndReleaseFault(faultId, "learncoding", VM_ID);

      expect(setupResult.executor.commands).toHaveLength(1);
      const command = setupResult.executor.commands[0]!;
      if (faultId in serviceTargets) {
        expect(command).toMatchObject({
          executable: "/usr/bin/docker",
          args: expectedServiceArgs(
            "restart",
            serviceTargets[faultId as keyof typeof serviceTargets],
          ),
        });
      } else if (faultId === "runner_service_restart") {
        expect(command).toMatchObject({
          executable: CONTROL,
          args: [
            "inject-and-release", faultId,
            "runner-service", "codestead-runner", "learncoding-runner.service",
            "--project", "learncoding", "--runner-vm-id", VM_ID,
            "--runner-vm-mac", VM_MAC,
          ],
        });
      } else {
        expect(testControlFaults).toContain(faultId);
        expect(command).toMatchObject({
          executable: CONTROL,
          args: [
            "inject-and-release", faultId, "test-control", faultId,
            "--project", "learncoding", "--runner-vm-id", VM_ID,
            "--runner-vm-mac", VM_MAC,
          ],
        });
      }
      expect(command.args.join(" ")).not.toMatch(
        /(?:systemctl\s+(?:stop|restart)\s+(?:docker|libvirt)|docker\s+(?:system\s+prune|stop)|unrelated)/,
      );
    },
  );

  it("resets each fault class only through its exact owned target", async () => {
    const service = setup();
    const runner = setup();
    const control = setup();

    await service.backend.resetFault("app_container_restart", "learncoding", VM_ID);
    await runner.backend.resetFault("runner_service_restart", "learncoding", VM_ID);
    await control.backend.resetFault("fake_gmail_failure", "learncoding", VM_ID);

    expect(service.executor.commands[0]).toMatchObject({
      executable: "/usr/bin/docker",
      args: expectedServiceArgs("start", "app"),
    });
    expect(runner.executor.commands[0]?.args.slice(0, 5)).toEqual([
      "reset", "runner_service_restart", "runner-service",
      "codestead-runner", "learncoding-runner.service",
    ]);
    expect(control.executor.commands[0]?.args.slice(0, 4)).toEqual([
      "reset", "fake_gmail_failure", "test-control", "fake_gmail_failure",
    ]);
    expect(service.executor.commands[0]?.args).not.toContain("up");
    expect(service.executor.commands[0]?.args).not.toContain("pull");
    expect(service.executor.commands[0]?.args).not.toContain("build");
  });

  it.each([
    ["project", "other", VM_ID],
    ["VM", "learncoding", "123e4567-e89b-42d3-a456-426614174000"],
  ])("rejects the wrong %s identity before mutation", async (_label, project, vmId) => {
    const setupResult = setup();

    await expect(setupResult.backend.injectAndReleaseFault(
      "app_container_restart",
      project as "learncoding",
      vmId,
    )).rejects.toThrow(/identity_mismatch/);

    expect(setupResult.executor.commands).toEqual([]);
  });

  it("rejects an unknown fault id before mutation", async () => {
    const setupResult = setup();

    await expect(setupResult.backend.resetFault(
      "host_docker_restart" as "app_container_restart",
      "learncoding",
      VM_ID,
    )).rejects.toThrow(/invalid_fault/);

    expect(setupResult.executor.commands).toEqual([]);
  });

  it("requires mutation commands to produce no stdout or stderr", async () => {
    const setupResult = setup({ executor: commandFixture((command, normal) =>
      command.executable === "/usr/bin/docker" && command.args.includes("restart")
        ? success(canonical({ unexpected: true }))
        : normal) });

    await expect(setupResult.backend.injectAndReleaseFault(
      "app_container_restart", "learncoding", VM_ID,
    )).rejects.toThrow(/invalid_output/);
  });
});

describe("production load Linux command containment", () => {
  it("bounds every timeout and output request", async () => {
    const setupResult = setup();

    await setupResult.backend.inspectIsolation();
    await setupResult.backend.captureHost();
    await setupResult.backend.captureRunnerVm(VM_ID);
    await setupResult.backend.probeFault(
      "app_container_restart", "baseline", "learncoding", VM_ID,
    );
    await setupResult.backend.runBrowserJourney("app_container_restart", "steady");
    await setupResult.backend.captureFaultInvariantEvidence(
      "app_container_restart", "learncoding", VM_ID,
    );

    expect(setupResult.executor.commands.length).toBeGreaterThan(0);
    for (const command of setupResult.executor.commands) {
      expect(command).toMatchObject({ cwd: "/opt/learncoding" });
      expect(command.timeoutMs).toBeGreaterThan(0);
      expect(command.timeoutMs).toBeLessThanOrEqual(120_000);
      expect(command.maximumOutputBytes).toBeGreaterThan(0);
      expect(command.maximumOutputBytes).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    }
  });

  it.each([
    ["timeout", (normal: ProductionLoadLinuxCommandResult) => ({ ...normal, timedOut: true })],
    ["nonzero", (normal: ProductionLoadLinuxCommandResult) => ({
      ...normal, exitCode: 7, stderr: bytes("super-secret-provider-token"),
    })],
    ["oversized", (normal: ProductionLoadLinuxCommandResult) => ({
      ...normal, stdout: Buffer.alloc(MAX_OUTPUT_BYTES + 1, 0x61),
    })],
  ] as const)("redacts %s command failures", async (_label, mutate) => {
    const setupResult = setup({ executor: commandFixture((command, normal) =>
      command.executable === CONTROL && command.args[0] === "host-telemetry"
        ? mutate(normal)
        : normal) });

    const promise = setupResult.backend.captureHost();
    await expect(promise).rejects.toThrow(/command_/);
    await expect(promise).rejects.not.toThrow(/secret|provider|token/i);
  });

  it("redacts executor exceptions", async () => {
    const commands: ProductionLoadLinuxCommand[] = [];
    const setupResult = setup({ executor: {
      commands,
      async execute(command) {
        commands.push(command);
        throw new Error("cookie=super-secret");
      },
    } });

    const promise = setupResult.backend.captureHost();
    await expect(promise).rejects.toThrow(/command_execution_failed/);
    await expect(promise).rejects.not.toThrow(/cookie|secret/i);
  });

  it("uses the exact browser executable and passes no URL or credentials in argv", async () => {
    const setupResult = setup();

    await setupResult.backend.runBrowserJourney("fake_ai_provider_failure", "recovered");

    expect(setupResult.executor.commands).toEqual([expect.objectContaining({
      executable: BROWSER,
      args: [
        "--fault-id", "fake_ai_provider_failure",
        "--stage", "recovered",
        "--project", "learncoding",
      ],
    })]);
    expect(setupResult.executor.commands[0]!.args.join(" ")).not.toMatch(
      /https?:|cookie|token|password|authorization/i,
    );
  });

  it("validates exact probe output", async () => {
    const setupResult = setup();

    await expect(setupResult.backend.probeFault(
      "quota_volume_near_full", "recovery", "learncoding", VM_ID,
    )).resolves.toEqual({ componentHealthy: true, alertOrDeadLetterVisible: false });
  });

  it("constructs invariant evidence from exact counts without accepting logs or secrets", async () => {
    const valid = setup();

    await expect(valid.backend.captureFaultInvariantEvidence(
      "fake_gmail_failure", "learncoding", VM_ID,
    )).resolves.toEqual({
      source: "isolated-production-load-backend-v1",
      faultId: "fake_gmail_failure",
      project: "learncoding",
      runnerVmId: VM_ID,
      observedAt: NOW,
      acknowledgedMutationFailures: 0,
      runnerMaxConcurrentJobs: 2,
      secretLeakFindings: 0,
    });

    const invalid = setup({ executor: commandFixture((command, normal) =>
      command.executable === CONTROL && command.args[0] === "invariant-evidence"
        ? success(canonical({
          observedAt: NOW,
          acknowledgedMutationFailures: 0,
          runnerMaxConcurrentJobs: 2,
          secretLeakFindings: 0,
          logs: "secret-bearing raw logs",
        }))
        : normal) });
    await expect(invalid.backend.captureFaultInvariantEvidence(
      "fake_gmail_failure", "learncoding", VM_ID,
    )).rejects.toThrow(/invalid_output/);
  });
});
