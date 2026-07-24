export type DisposableIntegrationTopologyFingerprint = Readonly<{
  fingerprint: string;
  journal_count: number;
}>;

type DisposableIntegrationCycleName = "initial" | "replay";
type DisposableIntegrationPhase =
  | `${DisposableIntegrationCycleName}-bootstrap`
  | `${DisposableIntegrationCycleName}-negative-probes`
  | `${DisposableIntegrationCycleName}-migration`
  | `${DisposableIntegrationCycleName}-reconciliation`
  | `${DisposableIntegrationCycleName}-boundary-verifier`
  | `${DisposableIntegrationCycleName}-verification`;

export type DisposableIntegrationTopologyDependencies = Readonly<{
  expectedJournalCount: number;
  reconcileRoles: () => Promise<void>;
  verifyRoleBoundaries: (requireApplicationObjects: boolean) => Promise<void>;
  migrate: () => Promise<void>;
  verifyTopology: () => Promise<DisposableIntegrationTopologyFingerprint | undefined>;
  onPhase?: (phase: DisposableIntegrationPhase) => void;
}>;

export function migrationJournalEntryCount(journal: unknown): number {
  if (
    typeof journal !== "object"
    || journal === null
    || !("entries" in journal)
    || !Array.isArray(journal.entries)
    || journal.entries.length === 0
    || journal.entries.some((entry, index) => (
      typeof entry !== "object"
      || entry === null
      || !("idx" in entry)
      || entry.idx !== index
      || !("tag" in entry)
      || typeof entry.tag !== "string"
      || entry.tag.length === 0
    ))
  ) {
    throw new Error("disposable integration migration journal validation failed");
  }
  return journal.entries.length;
}

function requireTopologyFingerprint(
  value: DisposableIntegrationTopologyFingerprint | undefined,
): DisposableIntegrationTopologyFingerprint {
  if (
    typeof value?.fingerprint !== "string"
    || value.fingerprint.length === 0
    || !Number.isSafeInteger(value.journal_count)
    || value.journal_count <= 0
  ) {
    throw new Error("disposable integration migration topology verification failed");
  }
  return value;
}

async function runCycle(
  name: DisposableIntegrationCycleName,
  dependencies: DisposableIntegrationTopologyDependencies,
) {
  dependencies.onPhase?.(`${name}-bootstrap`);
  await dependencies.reconcileRoles();
  dependencies.onPhase?.(`${name}-negative-probes`);
  await dependencies.verifyRoleBoundaries(false);
  dependencies.onPhase?.(`${name}-migration`);
  await dependencies.migrate();
  dependencies.onPhase?.(`${name}-reconciliation`);
  await dependencies.reconcileRoles();
  dependencies.onPhase?.(`${name}-boundary-verifier`);
  await dependencies.verifyRoleBoundaries(true);
  dependencies.onPhase?.(`${name}-verification`);
  return requireTopologyFingerprint(await dependencies.verifyTopology());
}

export async function runDisposableIntegrationReleaseCycles(
  dependencies: DisposableIntegrationTopologyDependencies,
) {
  if (
    !Number.isSafeInteger(dependencies.expectedJournalCount)
    || dependencies.expectedJournalCount <= 0
  ) {
    throw new Error("disposable integration expected migration journal count is invalid");
  }
  const firstCycle = await runCycle("initial", dependencies);
  const secondCycle = await runCycle("replay", dependencies);
  if (
    firstCycle.journal_count !== dependencies.expectedJournalCount
    || secondCycle.journal_count !== dependencies.expectedJournalCount
  ) {
    throw new Error("disposable integration migration journal count did not match");
  }
  if (
    secondCycle.journal_count !== firstCycle.journal_count
    || secondCycle.fingerprint !== firstCycle.fingerprint
  ) {
    throw new Error(
      "disposable integration migration topology changed across release replay",
    );
  }
  return { firstCycle, secondCycle } as const;
}
