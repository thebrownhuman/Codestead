import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createFailClosedProductionLoadSystemAdapter,
  type ProductionLoadSystemAdapter,
} from "./production-load-host";
import { createJournaledProductionLoadSystemAdapter } from "./production-load-journaled-system";

const VM_ID = "57b9ab11-f3a4-4ea8-a58e-e73d951f9d11";

async function setup(delegate: ProductionLoadSystemAdapter) {
  const journalRoot = await mkdtemp(path.join(os.tmpdir(), "codestead-journal-signal-"));
  return {
    journalRoot,
    ...createJournaledProductionLoadSystemAdapter({
      delegate,
      journalAccess: {
        journalRoot,
        project: "learncoding",
        runnerVmId: VM_ID,
        candidateRunIdentitySha256: `sha256:${"a".repeat(64)}`,
      },
      now: () => new Date("2026-07-20T04:05:06.007Z"),
    }),
  };
}

describe("journaled production load cancellation", () => {
  it("passes one signal through read and mutation delegates", async () => {
    const captureHost = vi.fn(async () => ({
      hostCpuPercent: 1,
      availableMemoryBytes: 1,
      rootFreeFraction: 1,
      rootFreeBytes: 1,
      diskReadBytes: 0,
      diskWriteBytes: 0,
      temperatureCelsius: 40,
      oomKills: 0,
      thermalThrottleIncrements: 0,
    }));
    const injectAndReleaseFault = vi.fn(async () => undefined);
    const setupResult = await setup({
      ...createFailClosedProductionLoadSystemAdapter(),
      captureHost,
      injectAndReleaseFault,
    });
    const signal = new AbortController().signal;

    await setupResult.system.captureHost(signal);
    await setupResult.system.injectAndReleaseFault(
      "app_container_restart",
      "learncoding",
      VM_ID,
      signal,
    );

    expect(captureHost).toHaveBeenCalledWith(signal);
    expect(injectAndReleaseFault).toHaveBeenCalledWith(
      "app_container_restart",
      "learncoding",
      VM_ID,
      signal,
    );
  });

  it("does not publish intent or mutate for a request cancelled while queued", async () => {
    const injectAndReleaseFault = vi.fn(async () => undefined);
    const setupResult = await setup({
      ...createFailClosedProductionLoadSystemAdapter(),
      injectAndReleaseFault,
    });
    const controller = new AbortController();
    controller.abort(new Error("credential=must-not-leak"));

    await expect(setupResult.system.injectAndReleaseFault(
      "app_container_restart",
      "learncoding",
      VM_ID,
      controller.signal,
    )).rejects.toThrow(/^Production load journaled system failed: aborted$/);

    expect(injectAndReleaseFault).not.toHaveBeenCalled();
    await expect(readFile(
      path.join(setupResult.journalRoot, "production-load-fault-journal.json"),
    )).rejects.toMatchObject({ code: "ENOENT" });
  });
});
