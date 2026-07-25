import { describe, expect, it } from "vitest";

import { buildDisposableIntegrationChildLaunch } from
  "../lib/disposable-integration-child-launch";

const ENVIRONMENT = {
  NODE_ENV: "test" as const,
  PATH: "C:\\runtime",
  SYSTEMROOT: "C:\\Windows",
};

describe("disposable integration child detachment", () => {
  it("detaches the direct POSIX child to create a killable process group", () => {
    expect(buildDisposableIntegrationChildLaunch({
      command: "/usr/bin/node",
      args: ["--test", "integration/example.integration.test.ts"],
      environment: ENVIRONMENT,
      platform: "linux",
    })).toMatchObject({
      detached: true,
      treeSupervised: false,
    });
  });

  it("keeps the Windows tree supervisor attached to its captured console", () => {
    expect(buildDisposableIntegrationChildLaunch({
      command: "C:\\runtime\\node.exe",
      args: ["--test", "integration\\example.integration.test.ts"],
      environment: ENVIRONMENT,
      platform: "win32",
    })).toMatchObject({
      detached: false,
      treeSupervised: true,
    });
  });
});
