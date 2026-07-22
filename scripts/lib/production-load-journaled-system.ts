import {
  clearProductionLoadFaultJournal,
  publishProductionLoadFaultIntent,
  recoverProductionLoadFaultJournal,
  type ProductionLoadFaultJournalAccess,
} from "./production-load-fault-journal";
import type { ProductionLoadSystemAdapter } from "./production-load-host";

type FaultId = Parameters<ProductionLoadSystemAdapter["resetFault"]>[0];

export type CreateJournaledProductionLoadSystemAdapterOptions = {
  readonly delegate: ProductionLoadSystemAdapter;
  readonly journalAccess: ProductionLoadFaultJournalAccess;
  readonly now?: () => Date;
};

function fail(code: string): never {
  throw new Error(`Production load journaled system failed: ${code}`);
}

function abortJournal(signal?: AbortSignal): void {
  if (signal?.aborted) fail("aborted");
}

async function withOptionalSignal<T>(
  signal: AbortSignal | undefined,
  withoutSignal: () => Promise<T>,
  withSignal: (value: AbortSignal) => Promise<T>,
): Promise<T> {
  abortJournal(signal);
  try {
    const result = await (signal ? withSignal(signal) : withoutSignal());
    abortJournal(signal);
    return result;
  } catch (error) {
    abortJournal(signal);
    throw error;
  }
}

function canonicalTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("invalid_clock");
  }
  return value.toISOString();
}

export function createJournaledProductionLoadSystemAdapter(
  options: CreateJournaledProductionLoadSystemAdapterOptions,
): {
  readonly system: ProductionLoadSystemAdapter;
  readonly recoverBeforeListen: () => Promise<{ readonly status: "empty" | "recovered" }>;
} {
  const now = options.now ?? (() => new Date());
  let mutationTail: Promise<void> = Promise.resolve();

  const assertIdentity = (project: "learncoding", runnerVmId: string): void => {
    if (project !== options.journalAccess.project
      || runnerVmId !== options.journalAccess.runnerVmId) {
      fail("identity_mismatch");
    }
  };

  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const resetAndVerify = async (faultId: FaultId): Promise<void> => {
    try {
      await options.delegate.resetFault(
        faultId,
        options.journalAccess.project,
        options.journalAccess.runnerVmId,
      );
      const [probe, unrelatedHealthy] = await Promise.all([
        options.delegate.probeFault(
          faultId,
          "recovery",
          options.journalAccess.project,
          options.journalAccess.runnerVmId,
        ),
        options.delegate.unrelatedServicesHealthy(options.journalAccess.project),
      ]);
      if (!probe.componentHealthy || !unrelatedHealthy) {
        fail("recovery_verification_failed");
      }
    } catch (error) {
      if (error instanceof Error
        && error.message === "Production load journaled system failed: recovery_verification_failed") {
        throw error;
      }
      fail("recovery_verification_failed");
    }
  };

  const system: ProductionLoadSystemAdapter = {
    captureHost: (signal) => withOptionalSignal(signal, () => options.delegate.captureHost(), (value) => options.delegate.captureHost(value)),
    captureRunnerVm: (runnerVmId, signal) => withOptionalSignal(signal, () => options.delegate.captureRunnerVm(runnerVmId), (value) => options.delegate.captureRunnerVm(runnerVmId, value)),
    unrelatedServicesHealthy: (project, signal) => withOptionalSignal(signal, () => options.delegate.unrelatedServicesHealthy(project), (value) => options.delegate.unrelatedServicesHealthy(project, value)),
    async resetFault(faultId, project, runnerVmId, signal) {
      assertIdentity(project, runnerVmId);
      return exclusive(async () => {
        abortJournal(signal);
        try {
          await withOptionalSignal(
            signal,
            () => options.delegate.resetFault(faultId, project, runnerVmId),
            (value) => options.delegate.resetFault(faultId, project, runnerVmId, value),
          );
        } catch {
          abortJournal(signal);
          fail("reset_failed");
        }
      });
    },
    probeFault: (faultId, phase, project, runnerVmId, signal) => {
      assertIdentity(project, runnerVmId);
      return withOptionalSignal(
        signal,
        () => options.delegate.probeFault(faultId, phase, project, runnerVmId),
        (value) => options.delegate.probeFault(faultId, phase, project, runnerVmId, value),
      );
    },
    async injectAndReleaseFault(faultId, project, runnerVmId, signal) {
      assertIdentity(project, runnerVmId);
      return exclusive(async () => {
        abortJournal(signal);
        let artifact;
        try {
          artifact = await publishProductionLoadFaultIntent({
            ...options.journalAccess,
            faultId,
            recordedAt: canonicalTimestamp(now),
          });
        } catch {
          fail("journal_publish_failed");
        }

        abortJournal(signal);
        try {
          await withOptionalSignal(
            signal,
            () => options.delegate.injectAndReleaseFault(faultId, project, runnerVmId),
            (value) => options.delegate.injectAndReleaseFault(faultId, project, runnerVmId, value),
          );
        } catch {
          abortJournal(signal);
          fail("mutation_failed");
        }

        abortJournal(signal);
        try {
          await clearProductionLoadFaultJournal({
            ...options.journalAccess,
            expected: artifact,
          });
        } catch {
          fail("journal_clear_failed");
        }
      });
    },
    runBrowserJourney: (faultId, stage, signal) => withOptionalSignal(
      signal,
      () => options.delegate.runBrowserJourney(faultId, stage),
      (value) => options.delegate.runBrowserJourney(faultId, stage, value),
    ),
    captureFaultInvariantEvidence: (faultId, project, runnerVmId, signal) => {
      assertIdentity(project, runnerVmId);
      return withOptionalSignal(
        signal,
        () => options.delegate.captureFaultInvariantEvidence(faultId, project, runnerVmId),
        (value) => options.delegate.captureFaultInvariantEvidence(
          faultId, project, runnerVmId, value,
        ),
      );
    },
    async close() {
      await mutationTail;
      await options.delegate.close?.();
    },
  };

  return {
    system,
    recoverBeforeListen: () => exclusive(async () => {
      const recovered = await recoverProductionLoadFaultJournal({
        ...options.journalAccess,
        resetAndVerify: (record) => resetAndVerify(record.faultId),
      });
      return { status: recovered.status };
    }),
  };
}
