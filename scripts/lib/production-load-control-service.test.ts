import { EventEmitter } from "node:events";

import { makeSignature } from "better-auth/crypto";
import { describe, expect, it, vi } from "vitest";

import type { ProductionLoadCandidate } from "../../src/lib/performance/load-report";
import type { ProductionLoadSystemAdapter } from "./production-load-host";
import {
  installProductionLoadControlSignalHandlers,
  recoverProductionLoadControlService,
  startProductionLoadControlService,
  type ProductionLoadControlServiceDependencies,
} from "./production-load-control-service";

const VM_ID = "123e4567-e89b-42d3-a456-426614174000";
const DECISION_HASH = "d".repeat(64);
const MANIFEST_HASH = "f".repeat(64);
const INVENTORY_HASH = "e".repeat(64);

function activeRelease(): string {
  return [
    "SCHEMA_VERSION=1",
    `GIT_COMMIT=${"a".repeat(40)}`,
    `GIT_TREE=${"b".repeat(40)}`,
    `RELEASE_MANIFEST_SHA256=${"1".repeat(64)}`,
    `APPLICATION_IMAGE_RECORD_SHA256=${"2".repeat(64)}`,
    "COMPOSE_PROJECT=learncoding",
    "COMPOSE_WORKDIR=/opt/learncoding",
    "PUBLIC_ORIGIN=https://learn.example.com",
    `MANAGED_INVENTORY_SHA256=${"3".repeat(64)}`,
    `FIREWALL_POLICY_SHA256=${"4".repeat(64)}`,
    `RUNNER_GUEST_RELEASE_SHA256=${"5".repeat(64)}`,
    `RUNNER_RUNTIME_IMAGES_SHA256=${"6".repeat(64)}`,
  ].join("\n") + "\n";
}

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    LOAD_MODE: "production",
    LOAD_ALLOW_REMOTE: "1",
    LOAD_BASE_URL: "https://learn.example.com",
    LOAD_SCOPE: "codestead-project-only",
    LOAD_PROJECT: "learncoding",
    LOAD_DISPOSABLE_FAULTS_CONFIRMED: "1",
    LOAD_EVIDENCE_ROOT: "/var/lib/learncoding-load-evidence",
    LOAD_ACTIVE_RELEASE_PATH: "/etc/learncoding/active-release.env",
    LOAD_CONTROL_SOCKET: "/run/learncoding/load-control.sock",
    LOAD_NUC_HOST_ID: "nuc-homelab:approved-host",
    LOAD_RUNNER_VM_ID: VM_ID,
  };
}

function candidate(): ProductionLoadCandidate {
  return {
    gitSha: "a".repeat(40),
    gitTree: "b".repeat(40),
    releaseManifestSha256: `sha256:${"1".repeat(64)}`,
    applicationImageRecordSha256: `sha256:${"2".repeat(64)}`,
    composeProject: "learncoding",
    composeWorkdir: "/opt/learncoding",
    publicOrigin: "https://learn.example.com",
    managedInventorySha256: `sha256:${"3".repeat(64)}`,
    firewallPolicySha256: `sha256:${"4".repeat(64)}`,
    runnerGuestReleaseSha256: `sha256:${"5".repeat(64)}`,
    runnerImageRecordSha256: `sha256:${"6".repeat(64)}`,
    nucHostId: "nuc-homelab:approved-host",
    runnerVmId: VM_ID,
    datasetId: "seed-20260715",
  };
}

function system(label: string, events: string[]): ProductionLoadSystemAdapter {
  return {
    captureHost: vi.fn(async () => { events.push(`${label}:capture-host`); return {} as never; }),
    captureRunnerVm: vi.fn(async () => ({} as never)),
    unrelatedServicesHealthy: vi.fn(async () => true),
    resetFault: vi.fn(async () => undefined),
    probeFault: vi.fn(async () => ({} as never)),
    injectAndReleaseFault: vi.fn(async () => undefined),
    runBrowserJourney: vi.fn(async () => undefined),
    captureFaultInvariantEvidence: vi.fn(async () => ({} as never)),
    close: vi.fn(async () => { events.push(`${label}:close`); }),
  };
}

function fixture() {
  const events: string[] = [];
  const rawBackend = {
    ...system("backend", events),
    inspectIsolation: vi.fn(async () => ({
      composeProject: "learncoding",
      runnerVmId: VM_ID,
      runnerVmMac: "52:54:00:20:00:12",
      repositoryRoot: "/opt/learncoding",
      runnerStateRoot: "/var/lib/learncoding-runner",
      maintenanceWindowApproved: true,
      freshRecoveryPoint: true,
      unrelatedInventorySha256: INVENTORY_HASH,
    })),
  };
  const guarded = system("guarded", events);
  const journaled = system("journaled", events);
  const host = {
    handle: vi.fn(async () => ({ ok: true })),
    close: vi.fn(async () => { events.push("host:close"); }),
  };
  const server = {
    socketPath: "/run/learncoding/load-control.sock",
    close: vi.fn(async () => { events.push("server:close"); }),
  };
  let hostOptions: Record<string, unknown> | undefined;
  let serverOptions: Record<string, unknown> | undefined;
  const recoverBeforeListen = vi.fn(async () => ({ status: "empty" as "empty" | "recovered" }));
  const deps: ProductionLoadControlServiceDependencies = {
    readActiveRelease: vi.fn(async () => ({
      path: "/etc/learncoding/active-release.env",
      byteLength: Buffer.byteLength(activeRelease()),
      sha256: "7".repeat(64),
      text: activeRelease(),
    })),
    assertActiveReleaseUnchanged: vi.fn(async () => undefined),
    readDecision: vi.fn(async ({ expectedCandidate }) => ({
      path: "/var/lib/learncoding-load-evidence/load-gate-decision.json",
      byteLength: 1,
      sha256: DECISION_HASH,
      decision: { candidate: expectedCandidate } as never,
    })),
    assertDecisionUnchanged: vi.fn(async () => undefined),
    readRunManifest: vi.fn(async ({ expectedCandidate, expectedDecisionSha256 }) => ({
      path: "/etc/learncoding/production-load-manifest.json",
      byteLength: 1,
      sha256: MANIFEST_HASH,
      candidateRunIdentitySha256: `sha256:${MANIFEST_HASH}`,
      manifest: {
        schemaVersion: 1 as const,
        decisionSha256: expectedDecisionSha256,
        candidate: expectedCandidate,
        runnerVmId: VM_ID,
        expectedUnrelatedInventorySha256: INVENTORY_HASH,
        validFrom: "2026-07-20T00:00:00.000Z",
        validUntil: "2026-07-20T08:00:00.000Z",
      },
    })),
    assertRunManifestUnchanged: vi.fn(async () => undefined),
    readCredential: vi.fn(async (name) => name === "database_url"
      ? "postgresql://app:password@postgres:5432/learncoding"
      : "better-auth-secret-with-at-least-thirty-two-characters"),
    createBackend: vi.fn(() => rawBackend),
    createGuardedSystem: vi.fn((options) => {
      expect(options.backend).toBe(rawBackend);
      expect(options.expectedUnrelatedInventorySha256).toBe(INVENTORY_HASH);
      return guarded;
    }),
    createJournaledSystem: vi.fn((options) => {
      expect(options.delegate).toBe(guarded);
      expect(options.journalAccess.candidateRunIdentitySha256).toBe(`sha256:${MANIFEST_HASH}`);
      return { system: journaled, recoverBeforeListen };
    }),
    assertPostgresSocketIdentity: vi.fn(async () => ({ device: 10, inode: 20 })),
    assertPostgresSocketUnchanged: vi.fn(() => undefined),
    createDatabase: vi.fn(() => ({
      query: vi.fn(async () => ({ rows: [] })),
      transaction: vi.fn(),
      close: vi.fn(async () => { events.push("database:close"); }),
    } as never)),
    createHost: vi.fn((options) => {
      hostOptions = options as unknown as Record<string, unknown>;
      expect(options.system).toBe(journaled);
      return host;
    }),
    startServer: vi.fn(async (options) => {
      serverOptions = options as unknown as Record<string, unknown>;
      expect(options.host).not.toBe(host);
      expect(options.socketUid).toBe(0);
      expect(options.socketGid).toBe(778);
      return server;
    }),
  };
  return { deps, events, rawBackend, guarded, journaled, host, server, recoverBeforeListen, get hostOptions() { return hostOptions; }, get serverOptions() { return serverOptions; } };
}

describe("production load control service assembly", () => {
  it.each([
    ["win32", 0],
    ["linux", 1000],
  ] as const)("refuses to assemble outside Linux root (%s uid %s)", async (platform, uid) => {
    const setup = fixture();
    await expect(startProductionLoadControlService({
      environment: environment(), repositoryRoot: "/opt/learncoding",
      platform, uid, gid: 778, now: () => new Date("2026-07-20T04:00:00.000Z"),
      dependencies: setup.deps,
    })).rejects.toThrow(/^Production load control service failed: linux_root_required$/);
    expect(setup.deps.readActiveRelease).not.toHaveBeenCalled();
  });

  it("assembles approved release -> manifest -> backend -> guard -> journal -> host -> server", async () => {
    const setup = fixture();
    const service = await startProductionLoadControlService({
      environment: environment(), repositoryRoot: "/opt/learncoding",
      platform: "linux", uid: 0, gid: 778,
      now: () => new Date("2026-07-20T04:00:00.000Z"), dependencies: setup.deps,
    });

    expect(setup.deps.readRunManifest).toHaveBeenCalledWith(expect.objectContaining({
      expectedCandidate: candidate(),
      expectedDecisionSha256: `sha256:${DECISION_HASH}`,
    }));
    expect(setup.deps.createBackend).toHaveBeenCalledWith({
      expectedRunnerVmId: VM_ID,
      controlExecutable: "/opt/learncoding/infra/ops/production-load-control.py",
      browserJourneyExecutable: "/opt/learncoding/infra/ops/production-load-browser-journey.py",
    });
    expect(setup.rawBackend.inspectIsolation).toHaveBeenCalled();
    expect(setup.deps.readCredential).toHaveBeenNthCalledWith(1, "database_url");
    expect(setup.deps.readCredential).toHaveBeenNthCalledWith(2, "better_auth_secret");
    expect(service.candidateRunIdentitySha256).toBe(`sha256:${MANIFEST_HASH}`);
    expect(service.decisionSha256).toBe(`sha256:${DECISION_HASH}`);

    const hostOptions = setup.hostOptions!;
    const sign = hostOptions.signSessionToken as (token: string) => Promise<string>;
    await expect(sign("session-token")).resolves.toBe(await makeSignature(
      "session-token",
      "better-auth-secret-with-at-least-thirty-two-characters",
    ));
    const random = hostOptions.randomSessionToken as () => string;
    expect(random()).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(random()).not.toBe(random());

    await service.close();
    await service.close();
    expect(setup.server.close).toHaveBeenCalledOnce();
    expect(setup.deps.assertPostgresSocketUnchanged).toHaveBeenCalledWith(
      { device: 10, inode: 20 },
      { device: 10, inode: 20 },
    );
  });

  it("fails before reading credentials when live isolation differs from the approved manifest", async () => {
    const setup = fixture();
    setup.rawBackend.inspectIsolation.mockResolvedValueOnce({
      ...(await setup.rawBackend.inspectIsolation()),
      unrelatedInventorySha256: "9".repeat(64),
    });
    await expect(startProductionLoadControlService({
      environment: environment(), repositoryRoot: "/opt/learncoding",
      platform: "linux", uid: 0, gid: 778,
      now: () => new Date("2026-07-20T04:00:00.000Z"), dependencies: setup.deps,
    })).rejects.toThrow(/^Production load control service failed: isolation_manifest_mismatch$/);
    expect(setup.deps.readCredential).not.toHaveBeenCalled();
    expect(setup.rawBackend.close).toHaveBeenCalledOnce();
  });

  it("closes host resources once when the server already cleaned up a failed startup", async () => {
    const setup = fixture();
    const dependencies: ProductionLoadControlServiceDependencies = {
      ...setup.deps,
      startServer: vi.fn(async (options) => {
        await options.host.close?.();
        throw new Error("credential=must-not-leak");
      }),
    };
    await expect(startProductionLoadControlService({
      environment: environment(), repositoryRoot: "/opt/learncoding",
      platform: "linux", uid: 0, gid: 778,
      now: () => new Date("2026-07-20T04:00:00.000Z"), dependencies,
    })).rejects.toThrow(
      /^Production load control service failed: startup_failed$/,
    );
    expect(setup.host.close).toHaveBeenCalledOnce();
  });

  it("revalidates approval, run manifest, and PostgreSQL socket around every request", async () => {
    const setup = fixture();
    await startProductionLoadControlService({
      environment: environment(), repositoryRoot: "/opt/learncoding",
      platform: "linux", uid: 0, gid: 778,
      now: () => new Date("2026-07-20T04:00:00.000Z"), dependencies: setup.deps,
    });
    const exposedHost = setup.serverOptions!.host as {
      handle(operation: "baseline", payload: unknown, signal?: AbortSignal): Promise<unknown>;
    };
    const signal = new AbortController().signal;
    await exposedHost.handle("baseline", {}, signal);
    expect(setup.host.handle).toHaveBeenCalledWith("baseline", {}, signal);
    expect(setup.deps.assertActiveReleaseUnchanged).toHaveBeenCalledTimes(3);
    expect(setup.deps.assertDecisionUnchanged).toHaveBeenCalledTimes(3);
    expect(setup.deps.assertRunManifestUnchanged).toHaveBeenCalledTimes(3);
    expect(setup.deps.assertPostgresSocketIdentity).toHaveBeenCalledTimes(4);
  });

  it("recovers one identity-bound active journal after expiry and exits without credentials or a listener", async () => {
    const setup = fixture();
    setup.recoverBeforeListen.mockResolvedValueOnce({ status: "recovered" });
    await expect(recoverProductionLoadControlService({
      environment: environment(), repositoryRoot: "/opt/learncoding",
      platform: "linux", uid: 0, gid: 778,
      now: () => new Date("2026-07-21T04:00:00.000Z"), dependencies: setup.deps,
    })).resolves.toEqual({
      status: "recovered",
      candidateRunIdentitySha256: `sha256:${MANIFEST_HASH}`,
    });
    expect(setup.deps.readRunManifest).toHaveBeenCalledWith(expect.objectContaining({
      validityMode: "recovery",
    }));
    expect(setup.deps.readCredential).not.toHaveBeenCalled();
    expect(setup.deps.createDatabase).not.toHaveBeenCalled();
    expect(setup.deps.createHost).not.toHaveBeenCalled();
    expect(setup.deps.startServer).not.toHaveBeenCalled();
    expect(setup.deps.assertActiveReleaseUnchanged).toHaveBeenCalledTimes(2);
    expect(setup.deps.assertDecisionUnchanged).toHaveBeenCalledTimes(2);
    expect(setup.deps.assertRunManifestUnchanged).toHaveBeenCalledTimes(2);
    expect(setup.rawBackend.close).toHaveBeenCalledOnce();
  });

  it("refuses recovery-only mode when no active journal is present", async () => {
    const setup = fixture();
    await expect(recoverProductionLoadControlService({
      environment: environment(), repositoryRoot: "/opt/learncoding",
      platform: "linux", uid: 0, gid: 778,
      now: () => new Date("2026-07-21T04:00:00.000Z"), dependencies: setup.deps,
    })).rejects.toThrow(
      /^Production load control service failed: recovery_journal_required$/,
    );
    expect(setup.deps.startServer).not.toHaveBeenCalled();
    expect(setup.rawBackend.close).toHaveBeenCalledOnce();
  });

  it("turns SIGTERM/SIGINT into one awaited, idempotent clean shutdown", async () => {
    const emitter = new EventEmitter();
    const close = vi.fn(async () => undefined);
    const installed = installProductionLoadControlSignalHandlers({
      service: { close },
      signals: emitter,
    });
    emitter.emit("SIGTERM");
    emitter.emit("SIGINT");
    await installed.done;
    expect(close).toHaveBeenCalledOnce();
    installed.remove();
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
    expect(emitter.listenerCount("SIGINT")).toBe(0);
  });
});
