import { describe, expect, it, vi } from "vitest";

import type { ProductionLoadCandidate } from "../../src/lib/performance/load-report";
import {
  startProductionLoadTestControlService,
  type ProductionLoadTestControlServiceDependencies,
} from "./production-load-test-control-service";

const VM_ID = "123e4567-e89b-42d3-a456-426614174000";
const DECISION_HASH = "d".repeat(64);
const MANIFEST_HASH = "f".repeat(64);
const SOCKET_PATH = "/run/learncoding/codestead-production-load-test-control.sock";

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
    LOAD_EVIDENCE_ROOT: "/var/lib/learncoding-production-load-evidence",
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

function fixture() {
  const adapter = { handle: vi.fn(async () => null), close: vi.fn(async () => undefined) };
  const server = { socketPath: SOCKET_PATH, close: vi.fn(async () => undefined) };
  let serverOptions: Record<string, unknown> | undefined;
  const deps: ProductionLoadTestControlServiceDependencies = {
    readActiveRelease: vi.fn(async () => ({
      path: "/etc/learncoding/active-release.env",
      byteLength: Buffer.byteLength(activeRelease()),
      sha256: "7".repeat(64),
      text: activeRelease(),
    })),
    assertActiveReleaseUnchanged: vi.fn(async () => undefined),
    readDecision: vi.fn(async ({ expectedCandidate }) => ({
      path: "/var/lib/learncoding-production-load-evidence/load-gate-decision.json",
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
        expectedUnrelatedInventorySha256: "e".repeat(64),
        validFrom: "2026-07-20T00:00:00.000Z",
        validUntil: "2026-07-20T08:00:00.000Z",
      },
    })),
    assertRunManifestUnchanged: vi.fn(async () => undefined),
    inspectSocketParent: vi.fn(async () => ({
      uid: 0, gid: 778, mode: 0o40750, nlink: 2,
      isDirectory: () => true,
      isSocket: () => false,
      isSymbolicLink: () => false,
    })),
    getSupplementaryGroups: vi.fn(() => [0, 778]),
    createAdapter: vi.fn(async () => adapter),
    startServer: vi.fn(async (options) => {
      serverOptions = options as unknown as Record<string, unknown>;
      return server;
    }),
  };
  return { deps, adapter, server, get serverOptions() { return serverOptions; } };
}

describe("production load test-control service assembly", () => {
  it.each([
    ["win32", 0, 0],
    ["linux", 1000, 0],
    ["linux", 0, 778],
  ] as const)("requires Linux root:root (%s uid=%s gid=%s)", async (platform, uid, gid) => {
    const setup = fixture();
    await expect(startProductionLoadTestControlService({
      environment: environment(), repositoryRoot: "/opt/learncoding",
      platform, uid, gid, now: () => new Date("2026-07-20T04:00:00.000Z"),
      dependencies: setup.deps,
    })).rejects.toThrow(/^Production load test-control service failed: linux_root_required$/);
    expect(setup.deps.readActiveRelease).not.toHaveBeenCalled();
  });

  it("binds one root-private socket to the approved candidate and manifest", async () => {
    const setup = fixture();
    const service = await startProductionLoadTestControlService({
      environment: environment(), repositoryRoot: "/opt/learncoding",
      platform: "linux", uid: 0, gid: 0,
      now: () => new Date("2026-07-20T04:00:00.000Z"),
      dependencies: setup.deps,
    });

    expect(setup.deps.readRunManifest).toHaveBeenCalledWith(expect.objectContaining({
      expectedCandidate: candidate(),
      expectedDecisionSha256: `sha256:${DECISION_HASH}`,
    }));
    expect(setup.deps.createAdapter).toHaveBeenCalledWith({
      candidate: candidate(),
      candidateRunIdentitySha256: `sha256:${MANIFEST_HASH}`,
      decisionSha256: `sha256:${DECISION_HASH}`,
      expectedUnrelatedInventorySha256: "e".repeat(64),
    });
    expect(setup.serverOptions).toMatchObject({
      socketPath: SOCKET_PATH,
      socketParentGid: 778,
      authority: {
        candidateRunIdentitySha256: `sha256:${MANIFEST_HASH}`,
        project: "learncoding",
        runnerVmId: VM_ID,
        runnerVmMac: "52:54:00:20:00:12",
      },
      maximumConcurrentRequests: 2,
      requestTimeoutMs: 125_000,
      adapter: setup.adapter,
    });
    expect(service).toMatchObject({
      socketPath: SOCKET_PATH,
      candidateRunIdentitySha256: `sha256:${MANIFEST_HASH}`,
      decisionSha256: `sha256:${DECISION_HASH}`,
    });
    await service.close();
    await service.close();
    expect(setup.server.close).toHaveBeenCalledOnce();
  });

  it("rejects a socket parent group outside the root process supplementary groups", async () => {
    const setup = fixture();
    setup.deps.getSupplementaryGroups = vi.fn(() => [0]);
    await expect(startProductionLoadTestControlService({
      environment: environment(), repositoryRoot: "/opt/learncoding",
      platform: "linux", uid: 0, gid: 0,
      now: () => new Date("2026-07-20T04:00:00.000Z"), dependencies: setup.deps,
    })).rejects.toThrow(/^Production load test-control service failed: unsafe_socket_parent$/);
    expect(setup.deps.createAdapter).not.toHaveBeenCalled();
  });

  it("revalidates release authority before and after every delegated request", async () => {
    const setup = fixture();
    await startProductionLoadTestControlService({
      environment: environment(), repositoryRoot: "/opt/learncoding",
      platform: "linux", uid: 0, gid: 0,
      now: () => new Date("2026-07-20T04:00:00.000Z"), dependencies: setup.deps,
    });
    const assertAuthority = setup.serverOptions!.assertAuthority as () => Promise<void>;
    await assertAuthority();
    expect(setup.deps.assertActiveReleaseUnchanged).toHaveBeenCalledTimes(2);
    expect(setup.deps.assertDecisionUnchanged).toHaveBeenCalledTimes(2);
    expect(setup.deps.assertRunManifestUnchanged).toHaveBeenCalledTimes(2);
  });

  it("closes an adapter once when listener startup fails without leaking the cause", async () => {
    const setup = fixture();
    setup.deps.startServer = vi.fn(async () => { throw new Error("secret=must-not-leak"); });
    await expect(startProductionLoadTestControlService({
      environment: environment(), repositoryRoot: "/opt/learncoding",
      platform: "linux", uid: 0, gid: 0,
      now: () => new Date("2026-07-20T04:00:00.000Z"), dependencies: setup.deps,
    })).rejects.toThrow(/^Production load test-control service failed: startup_failed$/);
    expect(setup.adapter.close).toHaveBeenCalledOnce();
  });
});
