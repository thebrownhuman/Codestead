export function isUnresolvedActiveRunnerReplay(input: {
  readonly duplicate: boolean;
  readonly status: string;
  readonly remoteJobId: string | null;
  readonly trustedRemoteResponseReceived: boolean;
}) {
  return !input.trustedRemoteResponseReceived
    && (
      input.remoteJobId !== null
      || (input.duplicate && (input.status === "leased" || input.status === "running"))
    );
}

export function isIndeterminateRunnerIdentityConflict(code: string | undefined) {
  return code === "REMOTE_JOB_ID_MISMATCH";
}

export class RunnerPersistenceAmbiguityError extends Error {
  constructor(
    readonly remoteJobId: string,
    cause: unknown,
  ) {
    super("Runner persistence outcome is indeterminate.", { cause });
    this.name = "RunnerPersistenceAmbiguityError";
  }
}

export async function persistRunnerMutationAfterRemote<T>(input: {
  readonly remoteJobId: string;
  readonly mutation: () => Promise<T>;
  readonly preserveError?: (error: unknown) => boolean;
}): Promise<T> {
  try {
    return await input.mutation();
  } catch (error) {
    if (input.preserveError?.(error)) throw error;
    throw new RunnerPersistenceAmbiguityError(input.remoteJobId, error);
  }
}

export function runnerFailureRequiresReconciliation(input: {
  readonly trustedRemoteResponseReceived: boolean;
  readonly remoteJobId: string | null;
}) {
  return input.trustedRemoteResponseReceived || input.remoteJobId !== null;
}

export function examFinalizationRunnerSeed(input: {
  readonly sessionId: string;
  readonly itemId: string;
  readonly revision: number;
  readonly runnerRequestGeneration: number;
}) {
  return `${input.sessionId}:${input.itemId}:final:${input.revision}:runner-${input.runnerRequestGeneration}`;
}

export function hasExactRunnerTestManifest(
  expected: readonly { readonly id: string; readonly visibility: string; readonly category: string }[],
  observed: {
    readonly tests: readonly {
      readonly id: string;
      readonly visibility: string;
      readonly category: string;
      readonly status: string;
    }[];
    readonly totals: { readonly passed: number; readonly failed: number; readonly total: number };
  },
) {
  if (
    observed.tests.length !== expected.length
    || observed.totals.total !== expected.length
    || observed.totals.passed + observed.totals.failed !== observed.totals.total
    || observed.totals.passed !== observed.tests.filter((test) => test.status === "PASSED").length
    || observed.totals.failed !== observed.tests.filter((test) => test.status !== "PASSED").length
  ) return false;
  const expectedById = new Map(expected.map((test) => [test.id, test]));
  if (expectedById.size !== expected.length) return false;
  const observedIds = new Set<string>();
  for (const test of observed.tests) {
    const pinned = expectedById.get(test.id);
    if (
      !pinned
      || observedIds.has(test.id)
      || pinned.visibility !== test.visibility
      || pinned.category !== test.category
    ) return false;
    observedIds.add(test.id);
  }
  return observedIds.size === expectedById.size;
}
