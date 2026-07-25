import { describe, expect, it, vi } from "vitest";

import {
  seedRepresentativeMailAuthorityRows,
} from "../lib/full-schema-restore-fixtures";
import type {
  FullSchemaRestoreQueryClient,
} from "../lib/full-schema-restore-database";

describe("full-schema restore representative mail fixtures", () => {
  it("arms and terminally releases account and system rows when 0064 binding exists", async () => {
    const ownerTrace: string[] = [];
    const workerTrace: string[] = [];
    const owner: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        ownerTrace.push(sql.replace(/\s+/gu, " ").trim());
        if (sql.includes("from pg_catalog.pg_attribute")) {
          return {
            rows: [
              { attname: "dispatch_binding_sha256" },
              { attname: "dispatch_binding_version" },
            ],
          };
        }
        if (
          sql.includes("status = 'quarantined'")
          && sql.includes("returning id")
        ) {
          return { rows: [{ id: "2" }, { id: "4" }] };
        }
        if (sql.includes("as fixture_count")) {
          return { rows: [{ fixture_count: "4" }] };
        }
        return { rows: [] };
      }),
    };
    const worker: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        workerTrace.push(sql.replace(/\s+/gu, " ").trim());
        return {
          rows: [
            { id: "00000000-0000-4000-8000-000000000002" },
            { id: "00000000-0000-4000-8000-000000000004" },
          ],
        };
      }),
    };

    await seedRepresentativeMailAuthorityRows({ owner, worker });

    expect(ownerTrace[0]).toContain("insert into public.user");
    expect(ownerTrace[0]).toContain("insert into public.access_request");
    expect(ownerTrace[0]).toContain(
      "full-schema-restore:system-quarantined:v1",
    );
    expect(ownerTrace[1]).toContain("from pg_catalog.pg_attribute");
    expect(workerTrace).toHaveLength(2);
    expect(workerTrace[0]).toContain("claim_token");
    expect(workerTrace[1]).toContain("dispatch_binding_version");
    expect(workerTrace[1]).toContain("'gmail-raw-v1'");
    expect(ownerTrace[2]).toContain("status = 'quarantined'");
    expect(ownerTrace[2]).toContain("claim_token = null");
    expect(ownerTrace[2]).toContain("lease_expires_at = null");
    expect(ownerTrace[2]).toContain("returning id");
    expect(ownerTrace.at(-1)).toContain("as fixture_count");
  });

  it("uses the released 0063 fixture shape before binding columns exist", async () => {
    const ownerTrace: string[] = [];
    const owner: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        ownerTrace.push(sql.replace(/\s+/gu, " ").trim());
        if (sql.includes("from pg_catalog.pg_attribute")) {
          return { rows: [] };
        }
        if (
          sql.includes("status = 'quarantined'")
          && sql.includes("returning id")
        ) {
          return { rows: [{ id: "2" }, { id: "4" }] };
        }
        if (sql.includes("as fixture_count")) {
          return { rows: [{ fixture_count: "4" }] };
        }
        return { rows: [] };
      }),
    };
    const worker = { query: vi.fn() };

    await seedRepresentativeMailAuthorityRows({ owner, worker });

    expect(worker.query).not.toHaveBeenCalled();
    expect(ownerTrace[2]).toContain("provider_call_started");
    expect(ownerTrace[2]).not.toContain("dispatch_binding_version");
    expect(ownerTrace[2]).toContain("lease_expires_at = null");
  });

  it("fails closed unless both quarantine fixtures reach terminal state", async () => {
    const owner: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from pg_catalog.pg_attribute")) {
          return { rows: [] };
        }
        if (
          sql.includes("status = 'quarantined'")
          && sql.includes("returning id")
        ) {
          return { rows: [{ id: "2" }] };
        }
        if (sql.includes("as fixture_count")) {
          return { rows: [{ fixture_count: "4" }] };
        }
        return { rows: [] };
      }),
    };

    await expect(seedRepresentativeMailAuthorityRows({
      owner,
      worker: { query: vi.fn() },
    })).rejects.toThrow("full-schema restore fixture transition failed");
  });

  it("fails closed on a partial 0064 catalog", async () => {
    const owner: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from pg_catalog.pg_attribute")) {
          return { rows: [{ attname: "dispatch_binding_sha256" }] };
        }
        return { rows: [] };
      }),
    };

    await expect(seedRepresentativeMailAuthorityRows({
      owner,
      worker: { query: vi.fn() },
    })).rejects.toThrow(
      "full-schema restore dispatch-binding catalog is invalid",
    );
  });

  it("fails if the exact four-fixture inventory is not present", async () => {
    const owner: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from pg_catalog.pg_attribute")) return { rows: [] };
        if (
          sql.includes("status = 'quarantined'")
          && sql.includes("returning id")
        ) {
          return { rows: [{ id: "2" }, { id: "4" }] };
        }
        if (sql.includes("as fixture_count")) {
          return { rows: [{ fixture_count: "3" }] };
        }
        return { rows: [] };
      }),
    };

    await expect(seedRepresentativeMailAuthorityRows({
      owner,
      worker: { query: vi.fn() },
    })).rejects.toThrow("full-schema restore fixture verification failed");
  });
});
