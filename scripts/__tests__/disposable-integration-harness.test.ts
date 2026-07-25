import path from "node:path";
import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  resolveDisposablePostgresImage,
  runWithDisposableIntegrationHarness,
} from "../lib/disposable-integration-harness";
import {
  POSTGRES_17_INTEGRATION_IMAGE,
  POSTGRES_18_INTEGRATION_IMAGE,
  type DisposablePostgresContainer,
} from "../lib/disposable-postgres-container";

describe("disposable integration harness", () => {
  it("defaults to pinned PostgreSQL 17 and accepts only the pinned PG18 target", () => {
    expect(resolveDisposablePostgresImage(undefined)).toEqual({
      image: POSTGRES_17_INTEGRATION_IMAGE,
      major: 17,
    });
    expect(resolveDisposablePostgresImage(
      POSTGRES_18_INTEGRATION_IMAGE,
    )).toEqual({
      image: POSTGRES_18_INTEGRATION_IMAGE,
      major: 18,
    });
    expect(() => resolveDisposablePostgresImage(
      "postgres:18-alpine",
    )).toThrow("invalid_postgres_image");
  });

  it("composes fresh home, exact container lifecycle, signal cleanup, and operation", async () => {
    const taskHomeDirectory = path.resolve("task-home", "harness");
    const order: string[] = [];
    const taskHomeCleanup = vi.fn(() => order.push("task-home-cleanup"));
    const container: DisposablePostgresContainer = {
      start: () => order.push("container-start"),
      cleanup: () => order.push("container-cleanup"),
      getIdentity: () => ({
        containerId: "a".repeat(64),
        port: 54321,
        database: "learncoding_integration",
        username: "learncoding_it",
      }),
    };
    const createContainer = vi.fn(() => container);
    const installSignalHandlers = vi.fn();

    const result = await runWithDisposableIntegrationHarness({
      dockerCommand: "docker",
      containerName: "learncoding-postgres-it-harness",
      port: 54321,
      database: "learncoding_integration",
      username: "learncoding_it",
      password: "password-canary",
      sourceEnvironment: { PATH: process.env.PATH },
      processTarget: {
        on: vi.fn(),
        exit: vi.fn(),
      },
      writeError: vi.fn(),
      terminateActiveChildren: vi.fn(async () => undefined),
      createTaskHome: () => ({
        path: taskHomeDirectory,
        cleanup: taskHomeCleanup,
      }),
      createContainer,
      installSignalHandlers,
    }, async (context) => {
      order.push("operation");
      expect(context.taskHomeDirectory).toBe(taskHomeDirectory);
      expect(context.postgresMajor).toBe(17);
      expect(context.container.getIdentity().containerId).toBe("a".repeat(64));
      return "complete";
    });

    expect(result).toBe("complete");
    expect(order).toEqual([
      "container-start",
      "operation",
      "container-cleanup",
      "task-home-cleanup",
    ]);
    expect(createContainer).toHaveBeenCalledWith(expect.objectContaining({
      image: POSTGRES_17_INTEGRATION_IMAGE,
      taskHomeDirectory,
    }));
    expect(installSignalHandlers).toHaveBeenCalledWith(expect.objectContaining({
      container,
      cleanupRuntime: taskHomeCleanup,
    }));
  });

  it("does not nest raw operation or task-home cleanup errors", async () => {
    const rawOperation = "raw-operation-secret-canary";
    const rawCleanup = "raw-home-path-canary";
    let failure: unknown;
    try {
      await runWithDisposableIntegrationHarness({
        dockerCommand: "docker",
        containerName: "learncoding-postgres-it-errors",
        port: 54321,
        database: "learncoding_integration",
        username: "learncoding_it",
        password: "password-canary",
        sourceEnvironment: {},
        processTarget: { on: vi.fn(), exit: vi.fn() },
        writeError: vi.fn(),
        terminateActiveChildren: vi.fn(async () => undefined),
        createTaskHome: () => ({
          path: path.resolve("task-home", "errors"),
          cleanup: () => {
            throw new Error(rawCleanup);
          },
        }),
        createContainer: () => ({
          start: () => undefined,
          cleanup: () => undefined,
          getIdentity: () => ({
            containerId: "a".repeat(64),
            port: 54321,
            database: "learncoding_integration",
            username: "learncoding_it",
          }),
        }),
        installSignalHandlers: vi.fn(),
      }, async () => {
        throw new Error(rawOperation);
      });
    } catch (error) {
      failure = error;
    }

    const rendered = [
      String(failure),
      inspect(failure),
      JSON.stringify(failure),
      JSON.stringify(Object.entries(failure as object)),
    ].join("\n");
    expect(rendered).toContain("harness_operation_and_home_cleanup_failed");
    expect(rendered).not.toContain(rawOperation);
    expect(rendered).not.toContain(rawCleanup);
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("errors");
  });
});
