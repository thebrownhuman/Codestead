import { randomBytes } from "node:crypto";

import { makeSignature } from "better-auth/crypto";

import { buildProductionLoadCandidateFromActiveRelease } from "../../src/lib/performance/load-report";
import {
  startProductionLoadControlServer,
  type ProductionLoadControlHost,
  type StartProductionLoadControlServerOptions,
} from "../production-load-control-server";
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
  createGuardedProductionLoadSystemAdapter,
  createProductionLoadHost,
  createUnixSocketProductionLoadDatabase,
  type CreateProductionLoadHostOptions,
  type GuardedProductionLoadSystemOptions,
  type ProductionLoadDatabase,
  type ProductionLoadHost,
  type ProductionLoadIsolationBackend,
  type ProductionLoadSystemAdapter,
} from "./production-load-host";
import {
  createJournaledProductionLoadSystemAdapter,
  type CreateJournaledProductionLoadSystemAdapterOptions,
} from "./production-load-journaled-system";
import {
  createProductionLoadLinuxIsolationBackend,
  type CreateProductionLoadLinuxIsolationBackendOptions,
} from "./production-load-linux-backend";
import {
  assertProductionLoadPostgresSocketIdentity,
  assertProductionLoadPostgresSocketUnchanged,
  type ProductionLoadPostgresSocketIdentity,
} from "./production-load-postgres-socket";
import {
  assertProductionLoadRunManifestUnchanged,
  readApprovedProductionLoadRunManifest,
  type ApprovedProductionLoadRunManifestArtifact,
  type ReadProductionLoadRunManifestOptions,
} from "./production-load-run-manifest";

export const PRODUCTION_LOAD_FAULT_JOURNAL_ROOT =
  "/var/lib/learncoding-production-load";
const CONTROL_EXECUTABLE =
  "/opt/learncoding/infra/ops/production-load-control.py";
const BROWSER_JOURNEY_EXECUTABLE =
  "/opt/learncoding/infra/ops/production-load-browser-journey.py";

type StartedServer = Awaited<ReturnType<typeof startProductionLoadControlServer>>;

export type ProductionLoadControlServiceDependencies = {
  readonly readActiveRelease: typeof readProductionLoadActiveRelease;
  readonly assertActiveReleaseUnchanged: typeof assertProductionLoadActiveReleaseUnchanged;
  readonly readDecision: typeof readApprovedProductionLoadDecision;
  readonly assertDecisionUnchanged: typeof assertProductionLoadDecisionUnchanged;
  readonly readRunManifest: typeof readApprovedProductionLoadRunManifest;
  readonly assertRunManifestUnchanged: typeof assertProductionLoadRunManifestUnchanged;
  readonly readCredential: (name: "database_url" | "better_auth_secret") => Promise<string>;
  readonly createBackend: (
    options: CreateProductionLoadLinuxIsolationBackendOptions,
  ) => ProductionLoadIsolationBackend;
  readonly createGuardedSystem: (
    options: GuardedProductionLoadSystemOptions,
  ) => ProductionLoadSystemAdapter;
  readonly createJournaledSystem: (
    options: CreateJournaledProductionLoadSystemAdapterOptions,
  ) => ReturnType<typeof createJournaledProductionLoadSystemAdapter>;
  readonly assertPostgresSocketIdentity: () => Promise<ProductionLoadPostgresSocketIdentity>;
  readonly assertPostgresSocketUnchanged: typeof assertProductionLoadPostgresSocketUnchanged;
  readonly createDatabase: (connectionString: string) => ProductionLoadDatabase;
  readonly createHost: (options: CreateProductionLoadHostOptions) => ProductionLoadHost;
  readonly startServer: (
    options: StartProductionLoadControlServerOptions,
  ) => Promise<StartedServer>;
};

export type StartProductionLoadControlServiceOptions = {
  readonly environment: NodeJS.ProcessEnv;
  readonly repositoryRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly gid?: number;
  readonly now?: () => Date;
  readonly dependencies: ProductionLoadControlServiceDependencies;
};

export type ProductionLoadControlService = {
  readonly socketPath: string;
  readonly decisionSha256: string;
  readonly candidateRunIdentitySha256: string;
  close(): Promise<void>;
};

function fail(code: string): never {
  throw new Error(`Production load control service failed: ${code}`);
}

function isServiceError(error: unknown): error is Error {
  return error instanceof Error
    && error.message.startsWith("Production load control service failed:");
}

function credential(value: string, kind: "database_url" | "better_auth_secret"): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 16 * 1024
    || /[\0\r\n]/.test(value)
    || (kind === "better_auth_secret" && value.length < 32)) {
    fail("invalid_credential");
  }
  return value;
}

function isolationMatchesManifest(
  isolation: Awaited<ReturnType<ProductionLoadIsolationBackend["inspectIsolation"]>>,
  manifest: ApprovedProductionLoadRunManifestArtifact,
): boolean {
  return isolation.composeProject === "learncoding"
    && isolation.runnerVmId === manifest.manifest.runnerVmId
    && isolation.runnerVmMac.toLowerCase() === "52:54:00:20:00:12"
    && isolation.repositoryRoot === "/opt/learncoding"
    && isolation.runnerStateRoot === "/var/lib/learncoding-runner"
    && isolation.maintenanceWindowApproved === true
    && isolation.freshRecoveryPoint === true
    && isolation.unrelatedInventorySha256
      === manifest.manifest.expectedUnrelatedInventorySha256;
}

export function createProductionLoadControlServiceDependencies(
  readCredential: ProductionLoadControlServiceDependencies["readCredential"],
): ProductionLoadControlServiceDependencies {
  return {
    readActiveRelease: readProductionLoadActiveRelease,
    assertActiveReleaseUnchanged: assertProductionLoadActiveReleaseUnchanged,
    readDecision: readApprovedProductionLoadDecision,
    assertDecisionUnchanged: assertProductionLoadDecisionUnchanged,
    readRunManifest: readApprovedProductionLoadRunManifest,
    assertRunManifestUnchanged: assertProductionLoadRunManifestUnchanged,
    readCredential,
    createBackend: createProductionLoadLinuxIsolationBackend,
    createGuardedSystem: createGuardedProductionLoadSystemAdapter,
    createJournaledSystem: createJournaledProductionLoadSystemAdapter,
    assertPostgresSocketIdentity: assertProductionLoadPostgresSocketIdentity,
    assertPostgresSocketUnchanged: assertProductionLoadPostgresSocketUnchanged,
    createDatabase: createUnixSocketProductionLoadDatabase,
    createHost: createProductionLoadHost,
    startServer: startProductionLoadControlServer,
  };
}

export async function startProductionLoadControlService(
  options: StartProductionLoadControlServiceOptions,
): Promise<ProductionLoadControlService> {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const gid = options.gid ?? process.getegid?.() ?? -1;
  if (platform !== "linux" || uid !== 0) fail("linux_root_required");
  if (!Number.isSafeInteger(gid) || gid < 0) fail("invalid_effective_group");
  if (options.repositoryRoot !== "/opt/learncoding") fail("invalid_repository_root");

  const now = options.now ?? (() => new Date());
  const dependencies = options.dependencies;
  let backend: ProductionLoadIsolationBackend | undefined;
  let database: ProductionLoadDatabase | undefined;
  let host: ProductionLoadHost | undefined;
  let closeHost: (() => Promise<void>) | undefined;
  let server: StartedServer | undefined;
  let startupComplete = false;

  try {
    const config = resolveProductionLoadConfig(options.environment, options.repositoryRoot);
    if (options.environment.LOAD_ACTIVE_RELEASE_PATH !== PRODUCTION_LOAD_ACTIVE_RELEASE_PATH) {
      fail("invalid_active_release_path");
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

    backend = dependencies.createBackend({
      expectedRunnerVmId: config.runnerVmId,
      controlExecutable: CONTROL_EXECUTABLE,
      browserJourneyExecutable: BROWSER_JOURNEY_EXECUTABLE,
    });
    const isolation = await backend.inspectIsolation();
    if (!isolationMatchesManifest(isolation, runManifest)
      || await backend.unrelatedServicesHealthy("learncoding") !== true) {
      fail("isolation_manifest_mismatch");
    }

    const databaseUrl = credential(
      await dependencies.readCredential("database_url"),
      "database_url",
    );
    const betterAuthSecret = credential(
      await dependencies.readCredential("better_auth_secret"),
      "better_auth_secret",
    );
    const initialPostgresIdentity = await dependencies.assertPostgresSocketIdentity();
    database = dependencies.createDatabase(databaseUrl);
    const guarded = dependencies.createGuardedSystem({
      expectedProject: "learncoding",
      expectedRunnerVmId: config.runnerVmId,
      expectedUnrelatedInventorySha256:
        runManifest.manifest.expectedUnrelatedInventorySha256,
      backend,
    });
    const journaled = dependencies.createJournaledSystem({
      delegate: guarded,
      journalAccess: {
        journalRoot: PRODUCTION_LOAD_FAULT_JOURNAL_ROOT,
        project: "learncoding",
        runnerVmId: config.runnerVmId,
        candidateRunIdentitySha256: runManifest.candidateRunIdentitySha256,
        requiredOwnerUid: 0,
        requiredRootMode: 0o700,
        requiredJournalMode: 0o600,
      },
      now,
    });
    host = dependencies.createHost({
      project: "learncoding",
      runnerVmId: config.runnerVmId,
      database,
      system: journaled.system,
      signSessionToken: (token) => makeSignature(token, betterAuthSecret),
      randomSessionToken: () => randomBytes(48).toString("base64url"),
      now,
    });
    let hostClosePromise: Promise<void> | undefined;
    closeHost = () => {
      hostClosePromise ??= host!.close();
      return hostClosePromise;
    };

    const assertRuntimeAuthority = async (): Promise<void> => {
      await dependencies.assertActiveReleaseUnchanged(activeRelease, activeReleaseOptions);
      await dependencies.assertDecisionUnchanged(decision, decisionOptions);
      await dependencies.assertRunManifestUnchanged(runManifest, runManifestOptions());
      const currentPostgresIdentity = await dependencies.assertPostgresSocketIdentity();
      dependencies.assertPostgresSocketUnchanged(
        initialPostgresIdentity,
        currentPostgresIdentity,
      );
    };
    const validatedHost: ProductionLoadControlHost = {
      async handle(operation, payload, signal) {
        await assertRuntimeAuthority();
        try {
          return await host!.handle(operation, payload, signal);
        } finally {
          await assertRuntimeAuthority();
        }
      },
      close: () => closeHost!(),
    };
    await assertRuntimeAuthority();
    server = await dependencies.startServer({
      socketPath: config.controlSocket,
      host: validatedHost,
      recoverBeforeListen: async () => {
        await assertRuntimeAuthority();
        await journaled.recoverBeforeListen();
        await assertRuntimeAuthority();
      },
      socketMode: 0o660,
      socketUid: uid,
      socketGid: gid,
      maximumConcurrentRequests: 2,
      requestTimeoutMs: 125_000,
    });
    startupComplete = true;

    let closePromise: Promise<void> | undefined;
    return {
      socketPath: server.socketPath,
      decisionSha256,
      candidateRunIdentitySha256: runManifest.candidateRunIdentitySha256,
      close() {
        closePromise ??= (async () => {
          let shutdownError: unknown;
          try {
            await server!.close();
          } catch (error) {
            shutdownError = error;
          }
          try {
            await assertRuntimeAuthority();
          } catch (error) {
            shutdownError ??= error;
          }
          if (shutdownError) fail("shutdown_failed");
        })();
        return closePromise;
      },
    };
  } catch (error) {
    if (!startupComplete) {
      try {
        if (server) await server.close();
        else if (closeHost) await closeHost();
        else {
          await Promise.allSettled([database?.close?.(), backend?.close?.()]);
        }
      } catch {
        // Startup failures are projected to stable, secret-free service errors below.
      }
    }
    if (isServiceError(error)) throw error;
    fail("startup_failed");
  }
}

export async function recoverProductionLoadControlService(
  options: StartProductionLoadControlServiceOptions,
): Promise<{
  readonly status: "recovered";
  readonly candidateRunIdentitySha256: string;
}> {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.() ?? -1;
  if (platform !== "linux" || uid !== 0) fail("linux_root_required");
  if (options.repositoryRoot !== "/opt/learncoding") fail("invalid_repository_root");
  const now = options.now ?? (() => new Date());
  const dependencies = options.dependencies;
  let backend: ProductionLoadIsolationBackend | undefined;
  try {
    const config = resolveProductionLoadConfig(options.environment, options.repositoryRoot);
    if (options.environment.LOAD_ACTIVE_RELEASE_PATH !== PRODUCTION_LOAD_ACTIVE_RELEASE_PATH) {
      fail("invalid_active_release_path");
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
    const runManifestOptions = (): ReadProductionLoadRunManifestOptions => ({
      expectedCandidate: candidate,
      expectedDecisionSha256: `sha256:${decision.sha256}`,
      now: now(),
      validityMode: "recovery",
    });
    const runManifest = await dependencies.readRunManifest(runManifestOptions());
    backend = dependencies.createBackend({
      expectedRunnerVmId: config.runnerVmId,
      controlExecutable: CONTROL_EXECUTABLE,
      browserJourneyExecutable: BROWSER_JOURNEY_EXECUTABLE,
    });
    const isolation = await backend.inspectIsolation();
    if (!isolationMatchesManifest(isolation, runManifest)
      || await backend.unrelatedServicesHealthy("learncoding") !== true) {
      fail("isolation_manifest_mismatch");
    }
    const guarded = dependencies.createGuardedSystem({
      expectedProject: "learncoding",
      expectedRunnerVmId: config.runnerVmId,
      expectedUnrelatedInventorySha256:
        runManifest.manifest.expectedUnrelatedInventorySha256,
      backend,
    });
    const journaled = dependencies.createJournaledSystem({
      delegate: guarded,
      journalAccess: {
        journalRoot: PRODUCTION_LOAD_FAULT_JOURNAL_ROOT,
        project: "learncoding",
        runnerVmId: config.runnerVmId,
        candidateRunIdentitySha256: runManifest.candidateRunIdentitySha256,
        requiredOwnerUid: 0,
        requiredRootMode: 0o700,
        requiredJournalMode: 0o600,
      },
      now,
    });
    const assertRecoveryAuthority = async (): Promise<void> => {
      await dependencies.assertActiveReleaseUnchanged(activeRelease, activeReleaseOptions);
      await dependencies.assertDecisionUnchanged(decision, decisionOptions);
      await dependencies.assertRunManifestUnchanged(runManifest, runManifestOptions());
    };
    await assertRecoveryAuthority();
    const recovered = await journaled.recoverBeforeListen();
    if (recovered.status !== "recovered") fail("recovery_journal_required");
    await assertRecoveryAuthority();
    return {
      status: "recovered",
      candidateRunIdentitySha256: runManifest.candidateRunIdentitySha256,
    };
  } catch (error) {
    if (isServiceError(error)) throw error;
    return fail("recovery_failed");
  } finally {
    try {
      await backend?.close?.();
    } catch {
      // Recovery errors are projected to stable, secret-free service errors.
    }
  }
}

export type ProductionLoadSignalEmitter = {
  once(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  off(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
};

export function installProductionLoadControlSignalHandlers(options: {
  readonly service: Pick<ProductionLoadControlService, "close">;
  readonly signals: ProductionLoadSignalEmitter;
}): { readonly done: Promise<void>; remove(): void } {
  let triggered = false;
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const remove = () => {
    options.signals.off("SIGTERM", handle);
    options.signals.off("SIGINT", handle);
  };
  const handle = () => {
    if (triggered) return;
    triggered = true;
    remove();
    void options.service.close().then(resolveDone, rejectDone);
  };
  options.signals.once("SIGTERM", handle);
  options.signals.once("SIGINT", handle);
  return { done, remove };
}
