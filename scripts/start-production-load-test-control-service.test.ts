import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { ProductionLoadTestControlServiceDependencies } from "./lib/production-load-test-control-service";
import type { ProductionLoadTestControlAdapterContext } from "./lib/production-load-test-control-service";
import type { ProductionLoadFixtureOperations } from "./lib/production-load-fixture-runtime";
import type { ProductionLoadTestControlAdapter } from "./lib/production-load-test-control-server";
import {
  createProductionLoadTestControlRuntimeAdapter,
  runProductionLoadTestControlServiceEntrypoint,
} from "./start-production-load-test-control-service";

const TEST_ENVIRONMENT = { NODE_ENV: "test" } satisfies NodeJS.ProcessEnv;

describe("production load test-control executable entrypoint", () => {
  it("serves until an awaited signal closes the root-private listener once", async () => {
    const signals = new EventEmitter();
    const close = vi.fn(async () => undefined);
    const dependencies = {} as ProductionLoadTestControlServiceDependencies;
    const startService = vi.fn(async () => {
      setTimeout(() => signals.emit("SIGTERM"), 0);
      return {
        socketPath: "/run/learncoding/codestead-production-load-test-control.sock",
        decisionSha256: `sha256:${"d".repeat(64)}`,
        candidateRunIdentitySha256: `sha256:${"f".repeat(64)}`,
        close,
      };
    });

    await runProductionLoadTestControlServiceEntrypoint({
      environment: TEST_ENVIRONMENT, argv: [], signals, dependencies, startService,
    });
    expect(startService).toHaveBeenCalledWith(expect.objectContaining({
      repositoryRoot: "/opt/learncoding",
      environment: TEST_ENVIRONMENT,
      dependencies,
    }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects every argument before starting privileged work", async () => {
    const startService = vi.fn();
    await expect(runProductionLoadTestControlServiceEntrypoint({
      environment: TEST_ENVIRONMENT, argv: ["--recover-only"], signals: new EventEmitter(),
      dependencies: {} as ProductionLoadTestControlServiceDependencies,
      startService,
    })).rejects.toThrow(
      /^Production load test-control entrypoint failed: invalid_arguments$/,
    );
    expect(startService).not.toHaveBeenCalled();
  });

  it("constructs the release-bound fixture adapter from the private Unix operations boundary", async () => {
    const context = {
      candidateRunIdentitySha256: `sha256:${"a".repeat(64)}`,
    } as ProductionLoadTestControlAdapterContext;
    const operations = {} as ProductionLoadFixtureOperations;
    const adapter = { handle: vi.fn() } as unknown as ProductionLoadTestControlAdapter;
    const createOperations = vi.fn(() => operations);
    const createAdapter = vi.fn(async () => adapter);
    const environment = { NODE_ENV: "test", LOAD_FIXTURE_APPROVED: "1" } satisfies NodeJS.ProcessEnv;

    await expect(createProductionLoadTestControlRuntimeAdapter({
      environment,
      context,
      dependencies: { createOperations, createAdapter },
    })).resolves.toBe(adapter);
    expect(createOperations).toHaveBeenCalledOnce();
    expect(createAdapter).toHaveBeenCalledWith({
      environment: {
        NODE_ENV: "test",
        LOAD_FIXTURE_APPROVED: "1",
        LOAD_FIXTURE_RUN_IDENTITY_SHA256: `sha256:${"a".repeat(64)}`,
      },
      context,
      operations,
    });
  });
});
