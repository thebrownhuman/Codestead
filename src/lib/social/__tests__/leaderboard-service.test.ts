import { describe, expect, it, vi } from "vitest";

import { loadCohortLeaderboards } from "../leaderboard-service";

const NOW = new Date("2026-07-12T12:00:00.000Z");

type StoredSnapshot = {
  id: string;
  user_id: string;
  period_kind: "weekly" | "all_time";
  period_key: string;
  formula_version: string;
  revision: number;
  total_points: number;
  components: Record<string, number>;
  evidence: Record<string, unknown>;
  evidence_hash: string;
  computed_at: Date;
};

function fakeLeaderboardPool(ownerCount: number) {
  const owners = Array.from({ length: ownerCount }, (_, index) => ({
    user_id: `private-user-${String(index).padStart(3, "0")}`,
    public_id: `public-${String(index).padStart(3, "0")}`,
    alias: `Learner ${String(index).padStart(3, "0")}`,
  }));
  const snapshots: StoredSnapshot[] = [];
  const clientQueryCounts: number[] = [];
  let evidenceGeneration = 1;
  let activeConnections = 0;
  let maximumActiveConnections = 0;

  const query = vi.fn(async (statementInput: string) => {
    const statement = statementInput.replace(/\s+/g, " ").trim().toLowerCase();
    if (statement.includes("from cohort_profile cp")) return { rows: owners, rowCount: owners.length };
    throw new Error(`Unexpected pool query: ${statement}`);
  });
  const connect = vi.fn(async () => {
    activeConnections += 1;
    maximumActiveConnections = Math.max(maximumActiveConnections, activeConnections);
    let queryCount = 0;
    let released = false;
    const clientQuery = vi.fn(async (statementInput: string, values: unknown[] = []) => {
      queryCount += 1;
      const statement = statementInput.replace(/\s+/g, " ").trim().toLowerCase();
      if (["begin", "commit", "rollback"].includes(statement) || statement.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.startsWith("select id from \"user\"")) {
        const userIds = values[0] as string[];
        return { rows: userIds.map((id) => ({ id })), rowCount: userIds.length };
      }
      if (statement.startsWith("with selected_owner")) {
        const userIds = values[0] as string[];
        const rows = userIds.flatMap((userId) => {
          const evidence = [{
            user_id: userId,
            category: "meaningful_day",
            evidence_key: "2026-07-07",
            evidence_at: new Date("2026-07-07T09:00:00.000Z"),
            kind: null,
          }];
          if (evidenceGeneration > 1 && userId === owners[0]?.user_id) {
            evidence.push({
              user_id: userId,
              category: "meaningful_day",
              evidence_key: "2026-07-08",
              evidence_at: new Date("2026-07-08T09:00:00.000Z"),
              kind: null,
            });
          }
          return evidence;
        });
        return { rows, rowCount: rows.length };
      }
      if (statement.startsWith("select distinct on")) {
        const userIds = new Set(values[0] as string[]);
        const weeklyKey = String(values[1]);
        const allTimeKey = String(values[2]);
        const formulaVersion = String(values[3]);
        const latest = new Map<string, StoredSnapshot>();
        for (const snapshot of snapshots) {
          if (!userIds.has(snapshot.user_id) || snapshot.formula_version !== formulaVersion) continue;
          if (snapshot.period_kind === "weekly" && snapshot.period_key !== weeklyKey) continue;
          if (snapshot.period_kind === "all_time" && snapshot.period_key !== allTimeKey) continue;
          const key = `${snapshot.user_id}:${snapshot.period_kind}:${snapshot.period_key}`;
          if (!latest.has(key) || latest.get(key)!.revision < snapshot.revision) latest.set(key, snapshot);
        }
        return { rows: [...latest.values()], rowCount: latest.size };
      }
      if (statement.startsWith("insert into leaderboard_score_snapshot")) {
        const inserted = JSON.parse(String(values[0])) as Array<Omit<StoredSnapshot, "id" | "computed_at"> & { computed_at: string }>;
        for (const row of inserted) {
          snapshots.push({
            ...row,
            id: `snapshot-${snapshots.length + 1}`,
            revision: Number(row.revision),
            computed_at: new Date(row.computed_at),
          });
        }
        return { rows: [], rowCount: inserted.length };
      }
      throw new Error(`Unexpected client query: ${statement}`);
    });
    return {
      query: clientQuery,
      release: () => {
        if (released) throw new Error("A leaderboard batch client was released twice.");
        released = true;
        activeConnections -= 1;
        clientQueryCounts.push(queryCount);
      },
    };
  });

  return {
    pool: { query, connect },
    owners,
    snapshots,
    clientQueryCounts,
    maximumActiveConnections: () => maximumActiveConnections,
    advanceEvidence: () => { evidenceGeneration += 1; },
  };
}

describe("batched cohort leaderboard scoring", () => {
  it("bounds pool use and round trips while preserving replay and revision semantics", async () => {
    const fake = fakeLeaderboardPool(51);

    const first = await loadCohortLeaderboards(NOW, fake.pool as never);
    expect(first.weekly.entries).toHaveLength(51);
    expect(first.weekly.entries[0]).toMatchObject({
      alias: "Learner 000",
      totalPoints: 12,
      components: { consistency: 12 },
    });
    expect(JSON.stringify(first)).not.toContain("private-user-");
    expect(fake.snapshots).toHaveLength(102);
    expect(new Set(fake.snapshots.map((snapshot) => snapshot.revision))).toEqual(new Set([1]));

    const replay = await loadCohortLeaderboards(NOW, fake.pool as never);
    expect(replay.weekly.entries).toEqual(first.weekly.entries);
    expect(replay.allTime.entries).toEqual(first.allTime.entries);
    expect(fake.snapshots).toHaveLength(102);

    fake.advanceEvidence();
    const revised = await loadCohortLeaderboards(NOW, fake.pool as never);
    expect(revised.weekly.entries[0]).toMatchObject({ alias: "Learner 000", totalPoints: 24 });
    expect(revised.allTime.entries[0]).toMatchObject({ alias: "Learner 000", totalPoints: 24 });
    expect(fake.snapshots).toHaveLength(104);
    const changed = fake.snapshots.filter((snapshot) => snapshot.user_id === fake.owners[0]?.user_id);
    expect(changed.map((snapshot) => snapshot.revision).sort()).toEqual([1, 1, 2, 2]);

    // 51 owners are processed as three sequential 25-owner batches per load,
    // rather than 102 simultaneously checked-out per-owner transactions.
    expect(fake.pool.connect).toHaveBeenCalledTimes(9);
    expect(fake.maximumActiveConnections()).toBe(1);
    expect(fake.clientQueryCounts).toHaveLength(9);
    expect(Math.max(...fake.clientQueryCounts)).toBeLessThanOrEqual(7);
  });

  it("does not acquire a scoring connection for an empty opted-in cohort", async () => {
    const fake = fakeLeaderboardPool(0);
    const result = await loadCohortLeaderboards(NOW, fake.pool as never);
    expect(result.weekly.entries).toEqual([]);
    expect(result.allTime.entries).toEqual([]);
    expect(fake.pool.connect).not.toHaveBeenCalled();
  });
});
