import { describe, expect, it, vi } from "vitest";

import integrationJournal from "../../drizzle/meta/_journal.json";
import {
  migrationJournalEntryCount,
  runDisposableIntegrationReleaseCycles,
} from "../lib/disposable-integration-topology";

type TopologyFingerprint = Readonly<{
  fingerprint: string;
  journal_count: number;
}>;

const fullTrace = [
  "roles", "boundary:false", "migrate", "roles", "boundary:true", "topology",
  "roles", "boundary:false", "migrate", "roles", "boundary:true", "topology",
] as const;

describe("disposable integration release topology", () => {
  it("derives the expected migration count from the checked-in journal", () => {
    expect(migrationJournalEntryCount(integrationJournal))
      .toBe(integrationJournal.entries.length);
  });

  it("runs real-boundary hooks around migration in each of two release cycles", async () => {
    const trace: string[] = [];
    const verifyTopology = vi.fn(async (): Promise<TopologyFingerprint> => ({
      fingerprint: "stable-topology",
      journal_count: 71,
    }));
    const result = await runDisposableIntegrationReleaseCycles({
      expectedJournalCount: 71,
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

    expect(trace).toEqual(fullTrace);
    expect(verifyTopology).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      firstCycle: { fingerprint: "stable-topology", journal_count: 71 },
      secondCycle: { fingerprint: "stable-topology", journal_count: 71 },
    });
  });

  it.each([1, 2, 3, 4])(
    "fails closed at boundary call %i with the exact completed prefix",
    async (failingCall) => {
      const trace: string[] = [];
      let boundaryCall = 0;
      await expect(runDisposableIntegrationReleaseCycles({
        expectedJournalCount: 71,
        reconcileRoles: async () => { trace.push("roles"); },
        verifyRoleBoundaries: async (requireApplicationObjects) => {
          trace.push(`boundary:${String(requireApplicationObjects)}`);
          boundaryCall += 1;
          if (boundaryCall === failingCall) {
            throw new Error("synthetic boundary failure");
          }
        },
        migrate: async () => { trace.push("migrate"); },
        verifyTopology: async () => {
          trace.push("topology");
          return { fingerprint: "stable-topology", journal_count: 71 };
        },
      })).rejects.toThrow("synthetic boundary failure");

      expect(trace).toEqual(fullTrace.slice(0, [2, 5, 8, 11][failingCall - 1]));
    },
  );

  it("rejects two stable positive cycles that are shorter than the journal", async () => {
    const verifyTopology = vi.fn(async (): Promise<TopologyFingerprint> => ({
      fingerprint: "stable-but-short",
      journal_count: 70,
    }));

    await expect(runDisposableIntegrationReleaseCycles({
      expectedJournalCount: 71,
      reconcileRoles: async () => undefined,
      verifyRoleBoundaries: async () => undefined,
      migrate: async () => undefined,
      verifyTopology,
    })).rejects.toThrow("migration journal count did not match");

    expect(verifyTopology).toHaveBeenCalledTimes(2);
  });
});
