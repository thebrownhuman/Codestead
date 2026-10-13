import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.query, connect: mocks.connect } }));
import { createLearnerExport, encodeExportLine, EXPORT_EXCLUDED_DATA, EXPORT_SCHEMA_VERSION } from "../export";
import { RETENTION_POLICY_VERSION } from "../policy";

const input = {
  learnerId: "learner-1", actorUserId: "admin-1", requestId: "81000000-0000-4000-8000-000000000021",
  now: new Date("2026-07-12T00:00:00Z"), maxRecords: 5_000, maxBytes: 1_000_000,
};

describe("demand-driven snapshot export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({
      query: (statement: string | { text: string }, values: unknown[]) => mocks.query(
        typeof statement === "string" ? statement : statement.text, values,
      ),
      release: mocks.release,
    });
    mocks.query.mockImplementation(async (statement: string) => ({
      rows: statement.includes("insert into data_lifecycle_run") ? [{ id: "run-1" }] : [],
    }));
  });

  it("does not produce data without downstream demand", async () => {
    const exported = await createLearnerExport(input);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.query.mock.calls.some(([sql]) => /\bas data\b/.test(sql))).toBe(false);
    const text = await new Response(exported.stream).text();
    expect(text).toContain('"type":"footer"');
    await exported.completion;
  });

  it("reads pages on one repeatable-read read-only connection", async () => {
    const exported = await createLearnerExport(input);
    await new Response(exported.stream).text();
    await exported.completion;
    const statements = mocks.query.mock.calls.map(([sql]) => sql as string);
    expect(statements).toContain("begin isolation level repeatable read read only");
    expect(statements).toContain("commit");
    expect(statements.indexOf("begin isolation level repeatable read read only"))
      .toBeLessThan(statements.findIndex((sql) => /\bas data\b/.test(sql)));
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("uses bounded keyset pages for a user with more than one page", async () => {
    const records = Array.from({ length: 1_205 }, (_, index) => ({ id: `row-${String(index).padStart(5, "0")}` }));
    mocks.query.mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-1" }] };
      if (!sql.includes("from consent_record c")) return { rows: [] };
      expect(sql).not.toMatch(/\boffset\b/i);
      expect(Number(values[1])).toBeLessThanOrEqual(1_000);
      const cursor = values[2] === null ? null : JSON.parse(String(values[2]));
      const start = cursor ? records.findIndex((row) => row.id === cursor[1]) + 1 : 0;
      return { rows: records.slice(start, start + Number(values[1])).map((data) => ({
        data, export_cursor: [input.now.toISOString(), data.id],
      })) };
    });
    const exported = await createLearnerExport(input);
    const lines = (await new Response(exported.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
    await exported.completion;
    expect(lines.filter((line) => line.type === "record").map((line) => line.data)).toEqual(records);
    expect(lines.at(-1)).toMatchObject({ records: 1_205, truncated: false });
  });

  it("preserves byte-identical manifest, records, footer and redaction framing", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into data_lifecycle_run")) return { rows: [{ id: "run-1" }] };
      return { rows: sql.includes('from "user" u left join learner_profile')
        ? [{ data: { id: "learner-1", name: "Learner" }, export_cursor: ["learner-1"] }] : [] };
    });
    const exported = await createLearnerExport(input);
    const expectedPrefix = encodeExportLine({
      type: "manifest", schemaVersion: EXPORT_SCHEMA_VERSION, policyVersion: RETENTION_POLICY_VERSION,
      generatedAt: input.now.toISOString(), learnerId: input.learnerId,
      limits: { maxRecords: input.maxRecords, maxBytes: input.maxBytes }, excluded: EXPORT_EXCLUDED_DATA,
      note: "Binary file contents are not embedded; downloadable file metadata is included.",
    }) + encodeExportLine({ type: "record", category: "profile", data: { id: "learner-1", name: "Learner" } });
    expect(await new Response(exported.stream).text()).toBe(expectedPrefix + encodeExportLine({
      type: "footer", records: 1, bytesBeforeFooter: Buffer.byteLength(expectedPrefix), truncated: false, completed: true,
    }));
    await exported.completion;
  });

  it("rolls back and releases the snapshot when the consumer cancels", async () => {
    const exported = await createLearnerExport(input);
    const completion = expect(exported.completion).rejects.toThrow(/cancel/i);
    const reader = exported.stream.getReader();
    await reader.read();
    await reader.cancel();
    await completion;
    expect(mocks.query).toHaveBeenCalledWith("rollback", expect.anything());
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("EXPORT_STREAM_FAILED"), expect.any(Array));
  });
});
