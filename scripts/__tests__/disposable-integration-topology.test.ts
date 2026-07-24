import { describe, expect, it, vi } from "vitest";

type TopologyFingerprint = Readonly<{
  fingerprint: string;
  journal_count: number;
}>;

type DisposableIntegrationTopologyModule = Readonly<{
  runDisposableIntegrationReleaseCycles: (dependencies: Readonly<{
    reconcileRoles: () => Promise<void>;
    verifyRoleBoundaries: (requireApplicationObjects: boolean) => Promise<void>;
    migrate: () => Promise<void>;
    verifyTopology: () => Promise<TopologyFingerprint | undefined>;
  }>) => Promise<Readonly<{
    firstCycle: TopologyFingerprint;
    secondCycle: TopologyFingerprint;
  }>>;
}>;

async function loadTopologyModule(): Promise<DisposableIntegrationTopologyModule | null> {
  const modulePath = "../lib/disposable-integration-topology";
  try {
    return await import(/* @vite-ignore */ modulePath) as DisposableIntegrationTopologyModule;
  } catch {
    return null;
  }
}

describe("disposable integration release topology", () => {
  it("runs real-boundary hooks around migration in each of two release cycles", async () => {
    const topology = await loadTopologyModule();
    expect(topology).not.toBeNull();
    if (!topology) return;

    const trace: string[] = [];
    const verifyTopology = vi.fn(async (): Promise<TopologyFingerprint> => ({
      fingerprint: "stable-topology",
      journal_count: 71,
    }));
    const result = await topology.runDisposableIntegrationReleaseCycles({
      reconcileRoles: async () => { trace.push("roles"); },
      verifyRoleBoundaries: async (requireApplicationObjects) => {
        trace.push(`boundary:${String(requireApplicationObjects)}`);
      },
      migrate: async () => { trace.push("migrate"); },
      verifyTopology: async () => {
        trace.push("topology");
        return verifyTopology();
      },
    });

    expect(trace).toEqual([
      "roles",
      "boundary:false",
      "migrate",
      "roles",
      "boundary:true",
      "topology",
      "roles",
      "boundary:false",
      "migrate",
      "roles",
      "boundary:true",
      "topology",
    ]);
    expect(verifyTopology).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      firstCycle: { fingerprint: "stable-topology", journal_count: 71 },
      secondCycle: { fingerprint: "stable-topology", journal_count: 71 },
    });
  });

  it.each([false, true])(
    "fails closed when the requireApplicationObjects=%s boundary hook fails",
    async (failingMode) => {
      const topology = await loadTopologyModule();
      expect(topology).not.toBeNull();
      if (!topology) return;

      const trace: string[] = [];
      await expect(topology.runDisposableIntegrationReleaseCycles({
        reconcileRoles: async () => { trace.push("roles"); },
        verifyRoleBoundaries: async (requireApplicationObjects) => {
          trace.push(`boundary:${String(requireApplicationObjects)}`);
          if (requireApplicationObjects === failingMode) {
            throw new Error("synthetic boundary failure");
          }
        },
        migrate: async () => { trace.push("migrate"); },
        verifyTopology: async () => {
          trace.push("topology");
          return { fingerprint: "not-reached", journal_count: 71 };
        },
      })).rejects.toThrow("synthetic boundary failure");

      expect(trace).toEqual(failingMode
        ? ["roles", "boundary:false", "migrate", "roles", "boundary:true"]
        : ["roles", "boundary:false"]);
    },
  );
});
