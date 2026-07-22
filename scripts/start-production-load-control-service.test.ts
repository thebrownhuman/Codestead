import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { ProductionLoadControlServiceDependencies } from "./lib/production-load-control-service";
import { runProductionLoadControlServiceEntrypoint } from "./start-production-load-control-service";

const TEST_ENVIRONMENT = { NODE_ENV: "test" } satisfies NodeJS.ProcessEnv;

describe("production load control executable entrypoint", () => {
  it("serves until an awaited signal closes the service exactly once", async () => {
    const signals = new EventEmitter();
    const close = vi.fn(async () => undefined);
    const dependencies = {} as ProductionLoadControlServiceDependencies;
    const startService = vi.fn(async () => {
      setTimeout(() => signals.emit("SIGTERM"), 0);
      return {
        socketPath: "/run/learncoding/load-control.sock",
        decisionSha256: `sha256:${"d".repeat(64)}`,
        candidateRunIdentitySha256: `sha256:${"f".repeat(64)}`,
        close,
      };
    });
    await runProductionLoadControlServiceEntrypoint({
      environment: TEST_ENVIRONMENT, argv: [], signals, dependencies, startService,
      recoverService: vi.fn(),
    });
    expect(startService).toHaveBeenCalledWith(expect.objectContaining({
      repositoryRoot: "/opt/learncoding",
      environment: TEST_ENVIRONMENT,
      dependencies,
    }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("runs identity-bound boot recovery and exits without starting a listener", async () => {
    const dependencies = {} as ProductionLoadControlServiceDependencies;
    const recoverService = vi.fn(async () => ({
      status: "recovered" as const,
      candidateRunIdentitySha256: `sha256:${"f".repeat(64)}`,
    }));
    const startService = vi.fn();
    await runProductionLoadControlServiceEntrypoint({
      environment: TEST_ENVIRONMENT, argv: ["--recover-only"], signals: new EventEmitter(),
      dependencies, startService, recoverService,
    });
    expect(recoverService).toHaveBeenCalledOnce();
    expect(startService).not.toHaveBeenCalled();
  });

  it.each([
    ["--unknown"],
    ["--recover-only", "extra"],
  ])("rejects unsupported arguments without starting any privileged work", async (...argv) => {
    const startService = vi.fn();
    const recoverService = vi.fn();
    await expect(runProductionLoadControlServiceEntrypoint({
      environment: TEST_ENVIRONMENT, argv, signals: new EventEmitter(),
      dependencies: {} as ProductionLoadControlServiceDependencies,
      startService, recoverService,
    })).rejects.toThrow(
      /^Production load control entrypoint failed: invalid_arguments$/,
    );
    expect(startService).not.toHaveBeenCalled();
    expect(recoverService).not.toHaveBeenCalled();
  });
});
