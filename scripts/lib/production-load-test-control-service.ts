import { lstat } from "node:fs/promises";
import path from "node:path";

import {
  buildProductionLoadCandidateFromActiveRelease,
  type ProductionLoadCandidate,
} from "../../src/lib/performance/load-report";
import {
  assertProductionLoadActiveReleaseUnchanged,
  PRODUCTION_LOAD_ACTIVE_RELEASE_PATH,
  readProductionLoadActiveRelease,
  type ReadProductionLoadActiveReleaseOptions,
} from "./production-load-active-release";
import { resolveProductionLoadConfig } from "./production-load-config";
import {
  assertProductionLoadDecisionUnchanged,
  readApprovedProductionLoadDecision,
} from "./production-load-evidence";
import {
  assertProductionLoadRunManifestUnchanged,
  readApprovedProductionLoadRunManifest,
  type ReadProductionLoadRunManifestOptions,
} from "./production-load-run-manifest";
import {
  PRODUCTION_LOAD_TEST_CONTROL_SOCKET,
  startProductionLoadTestControlUnixServer,
  validateProductionLoadTestControlSocketDirectory,
  type ProductionLoadTestControlAdapter,
  type ProductionLoadTestControlSocketStat,
} from "./production-load-test-control-server";

const PRODUCTION_LOAD_CONTROL_SOCKET = "/run/learncoding/load-control.sock";
const RUNNER_VM_MAC = "52:54:00:20:00:12" as const;

type TestControlServerOptions = Parameters<
  typeof startProductionLoadTestControlUnixServer
>[0];
type StartedTestControlServer = Awaited<
  ReturnType<typeof startProductionLoadTestControlUnixServer>
>;

export type ProductionLoadTestControlAdapterContext = {
  readonly candidate: ProductionLoadCandidate;
  readonly candidateRunIdentitySha256: string;
  readonly decisionSha256: string;
  readonly expectedUnrelatedInventorySha256: string;
};

export type ProductionLoadTestControlServiceDependencies = {
  readonly readActiveRelease: typeof readProductionLoadActiveRelease;
  readonly assertActiveReleaseUnchanged: typeof assertProductionLoadActiveReleaseUnchanged;
  readonly readDecision: typeof readApprovedProductionLoadDecision;
  readonly assertDecisionUnchanged: typeof assertProductionLoadDecisionUnchanged;
  readonly readRunManifest: typeof readApprovedProductionLoadRunManifest;
  readonly assertRunManifestUnchanged: typeof assertProductionLoadRunManifestUnchanged;
  readonly inspectSocketParent: (
    target: string,
  ) => Promise<ProductionLoadTestControlSocketStat>;
  getSupplementaryGroups(): readonly number[];
  createAdapter(
    context: ProductionLoadTestControlAdapterContext,
  ): Promise<ProductionLoadTestControlAdapter>;
  startServer(options: TestControlServerOptions): Promise<StartedTestControlServer>;
};

export type StartProductionLoadTestControlServiceOptions = {
  readonly environment: NodeJS.ProcessEnv;
  readonly repositoryRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly gid?: number;
  readonly now?: () => Date;
  readonly dependencies: ProductionLoadTestControlServiceDependencies;
};

export type ProductionLoadTestControlService = {
  readonly socketPath: string;
  readonly candidateRunIdentitySha256: string;
  readonly decisionSha256: string;
  close(): Promise<void>;
};

function fail(code: string): never {
  throw new Error(`Production load test-control service failed: ${code}`);
}

function isServiceError(error: unknown): error is Error {
  return error instanceof Error
    && error.message.startsWith("Production load test-control service failed:");
}

function safeGroups(values: readonly number[]): readonly number[] {
  if (!Array.isArray(values)
    || values.length < 1
    || values.length > 256
    || values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    fail("invalid_supplementary_groups");
  }
  return values;
}

export function createProductionLoadTestControlServiceDependencies(
  createAdapter: ProductionLoadTestControlServiceDependencies["createAdapter"],
): ProductionLoadTestControlServiceDependencies {
  return {
    readActiveRelease: readProductionLoadActiveRelease,
    assertActiveReleaseUnchanged: assertProductionLoadActiveReleaseUnchanged,
    readDecision: readApprovedProductionLoadDecision,
    assertDecisionUnchanged: assertProductionLoadDecisionUnchanged,
    readRunManifest: readApprovedProductionLoadRunManifest,
    assertRunManifestUnchanged: assertProductionLoadRunManifestUnchanged,
    inspectSocketParent: lstat,
    getSupplementaryGroups: () => process.getgroups?.() ?? [],
    createAdapter,
    startServer: startProductionLoadTestControlUnixServer,
  };
}

export async function startProductionLoadTestControlService(
  options: StartProductionLoadTestControlServiceOptions,
): Promise<ProductionLoadTestControlService> {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const gid = options.gid ?? process.getegid?.() ?? -1;
  if (platform !== "linux" || uid !== 0 || gid !== 0) fail("linux_root_required");
  if (options.repositoryRoot !== "/opt/learncoding") fail("invalid_repository_root");

  const dependencies = options.dependencies;
  const now = options.now ?? (() => new Date());
  let adapter: ProductionLoadTestControlAdapter | undefined;
  let server: StartedTestControlServer | undefined;
  let startupComplete = false;

  try {
    const config = resolveProductionLoadConfig(options.environment, options.repositoryRoot);
    if (options.environment.LOAD_ACTIVE_RELEASE_PATH !== PRODUCTION_LOAD_ACTIVE_RELEASE_PATH) {
      fail("invalid_active_release_path");
    }
    if (options.environment.LOAD_CONTROL_SOCKET !== PRODUCTION_LOAD_CONTROL_SOCKET) {
      fail("invalid_control_socket");
    }

    const activeReleaseOptions: ReadProductionLoadActiveReleaseOptions = {
      activeReleasePath: config.activeReleasePath,
    };
    const activeRelease = await dependencies.readActiveRelease(activeReleaseOptions);
    const candidate = buildProductionLoadCandidateFromActiveRelease(
      activeRelease.text,
      config.nucHostId,
      config.runnerVmId,
    );
    if (candidate.publicOrigin !== config.baseUrl.origin) fail("candidate_origin_mismatch");

    const decisionOptions = {
      evidenceRoot: config.evidenceRoot,
      expectedCandidate: candidate,
    } as const;
    const decision = await dependencies.readDecision(decisionOptions);
    const decisionSha256 = `sha256:${decision.sha256}`;
    const runManifestOptions = (): ReadProductionLoadRunManifestOptions => ({
      expectedCandidate: candidate,
      expectedDecisionSha256: decisionSha256,
      now: now(),
    });
    const runManifest = await dependencies.readRunManifest(runManifestOptions());

    const parentPath = path.posix.dirname(PRODUCTION_LOAD_TEST_CONTROL_SOCKET);
    const parent = await dependencies.inspectSocketParent(parentPath);
    try {
      validateProductionLoadTestControlSocketDirectory(parent, parent.gid);
    } catch {
      fail("unsafe_socket_parent");
    }
    const groups = safeGroups(dependencies.getSupplementaryGroups());
    if (!groups.includes(parent.gid)) fail("unsafe_socket_parent");

    const assertRuntimeAuthority = async (): Promise<void> => {
      await dependencies.assertActiveReleaseUnchanged(activeRelease, activeReleaseOptions);
      await dependencies.assertDecisionUnchanged(decision, decisionOptions);
      await dependencies.assertRunManifestUnchanged(runManifest, runManifestOptions());
    };

    adapter = await dependencies.createAdapter({
      candidate,
      candidateRunIdentitySha256: runManifest.candidateRunIdentitySha256,
      decisionSha256,
      expectedUnrelatedInventorySha256:
        runManifest.manifest.expectedUnrelatedInventorySha256,
    });
    await assertRuntimeAuthority();
    server = await dependencies.startServer({
      socketPath: PRODUCTION_LOAD_TEST_CONTROL_SOCKET,
      socketParentGid: parent.gid,
      authority: {
        candidateRunIdentitySha256: runManifest.candidateRunIdentitySha256,
        project: "learncoding",
        runnerVmId: config.runnerVmId,
        runnerVmMac: RUNNER_VM_MAC,
      },
      adapter,
      assertAuthority: assertRuntimeAuthority,
      maximumConcurrentRequests: 2,
      requestTimeoutMs: 125_000,
      platform,
      uid,
      gid,
    });
    startupComplete = true;

    let closePromise: Promise<void> | undefined;
    return {
      socketPath: server.socketPath,
      candidateRunIdentitySha256: runManifest.candidateRunIdentitySha256,
      decisionSha256,
      close() {
        closePromise ??= (async () => {
          try {
            await server!.close();
            await assertRuntimeAuthority();
          } catch {
            fail("shutdown_failed");
          }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    if (!startupComplete) {
      try {
        if (server) await server.close();
        else await adapter?.close?.();
      } catch {
        // The stable service error below deliberately contains no adapter detail.
      }
    }
    if (isServiceError(error)) throw error;
    fail("startup_failed");
  }
}
