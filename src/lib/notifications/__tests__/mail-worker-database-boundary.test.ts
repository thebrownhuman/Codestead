import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const applicationDatabaseClient = vi.hoisted(() => ({
  moduleLoads: 0,
}));

vi.mock("@/lib/db/client", () => {
  applicationDatabaseClient.moduleLoads += 1;
  throw new Error(
    "The mail worker dependency graph imported the application database client.",
  );
});

describe("mail worker database boundary", () => {
  beforeEach(() => {
    vi.resetModules();
    applicationDatabaseClient.moduleLoads = 0;
  });

  it("has no direct global-client import and loads its database graph without one", async () => {
    const processSource = await readFile(
      resolve(process.cwd(), "scripts/process-outbox.ts"),
      "utf8",
    );

    expect(processSource).not.toMatch(
      /(?:@\/lib\/db\/client|\.\.\/src\/lib\/db\/client)/u,
    );

    await Promise.all([
      import("../mail-dispatch-pool"),
      import("../inactivity"),
      import("../smart-reminders"),
      import("../delivery-variables"),
    ]);

    expect(applicationDatabaseClient.moduleLoads).toBe(0);
  });
});
