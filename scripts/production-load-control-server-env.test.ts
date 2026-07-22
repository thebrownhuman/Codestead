import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveProductionLoadControlSocket } from "./production-load-control-server";

describe("production load control server environment", () => {
  it("uses only the absolute dedicated LOAD_CONTROL_SOCKET path", () => {
    const socketPath = path.resolve("test-results", "control", "load.sock");
    expect(resolveProductionLoadControlSocket({
      NODE_ENV: "test",
      LOAD_MODE: "production",
      LOAD_SCOPE: "codestead-project-only",
      LOAD_PROJECT: "learncoding",
      LOAD_CONTROL_SOCKET: socketPath,
    })).toBe(socketPath);
  });

  it.each([
    [{}, "missing"],
    [{ LOAD_MODE: "smoke" }, "wrong mode"],
    [{ LOAD_SCOPE: "disposable-only" }, "wrong scope"],
    [{ LOAD_PROJECT: "other" }, "wrong project"],
    [{ LOAD_CONTROL_SOCKET: "relative.sock" }, "relative path"],
  ])("fails closed for %s (%s)", (override, _label) => {
    void _label;
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      LOAD_MODE: "production",
      LOAD_SCOPE: "codestead-project-only",
      LOAD_PROJECT: "learncoding",
      LOAD_CONTROL_SOCKET: path.resolve("test-results", "control", "load.sock"),
      ...override,
    };
    if (Object.keys(override).length === 0) delete environment.LOAD_CONTROL_SOCKET;
    expect(() => resolveProductionLoadControlSocket(environment)).toThrow(
      /invalid_environment/,
    );
  });
});
