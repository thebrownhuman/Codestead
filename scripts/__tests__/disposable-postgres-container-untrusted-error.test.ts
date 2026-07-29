import path from "node:path";
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { DisposableIntegrationLifecycleError } from
  "../lib/disposable-integration-error";
import {
  createDisposablePostgresContainer,
  runWithDisposablePostgresContainer,
} from "../lib/disposable-postgres-container";

const PG17_IMAGE =
  "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";

function renderedFailure(error: unknown): string {
  return [
    String(error),
    inspect(error),
    JSON.stringify(error),
    JSON.stringify(Object.entries(error as object)),
  ].join("\n");
}

describe("disposable container untrusted error boundaries", () => {
  it("maps a lifecycle-shaped operation error to a fixed safe code", async () => {
    const rawCode = "raw-operation-code C:\\secret\\path-canary";
    let failure: unknown;
    try {
      await runWithDisposablePostgresContainer({
        start: () => undefined,
        cleanup: () => undefined,
      }, async () => {
        throw new DisposableIntegrationLifecycleError(rawCode);
      });
    } catch (error) {
      failure = error;
    }

    const rendered = renderedFailure(failure);
    expect(rendered).toContain("operation_failed");
    expect(rendered).not.toContain(rawCode);
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("errors");
  });

  it("maps a lifecycle-shaped injected password-file error to a fixed safe code", () => {
    const rawCode = "raw-password-code /secret/path-canary";
    const container = createDisposablePostgresContainer({
      dockerCommand: "docker",
      containerName: "learncoding-postgres-it-untrusted",
      image: PG17_IMAGE,
      port: 54321,
      database: "learncoding_integration",
      username: "codestead_it",
      password: "secret-canary",
      taskHomeDirectory: path.resolve("task-home", "untrusted"),
      sourceEnvironment: { PATH: process.env.PATH },
      execute: () => ({ status: 0, stdout: "28.0.0\n" }),
      createPasswordFile: () => {
        throw new DisposableIntegrationLifecycleError(rawCode);
      },
    });

    let failure: unknown;
    try {
      container.start();
    } catch (error) {
      failure = error;
    }
    const rendered = renderedFailure(failure);
    expect(rendered).toContain("password_file_create_failed");
    expect(rendered).not.toContain(rawCode);
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("errors");
  });
});
