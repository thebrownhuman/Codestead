import { describe, expect, it, vi } from "vitest";

import {
  type LearningRequestDatabase,
  LearningRequestRepositoryError,
  PostgresLearningRequestRepository,
} from "../repository";

const input = {
  userId: "learner-user",
  requestId: "10000000-0000-4000-8000-000000000001",
  kind: "new-subject" as const,
  subject: "Distributed systems",
  details: "Consensus, failure models, and evidence-driven projects.",
};

const storedRow = {
  id: "20000000-0000-4000-8000-000000000001",
  kind: input.kind,
  subject: input.subject,
  details: input.details,
  status: "pending",
  decision_reason: null,
  created_at: new Date("2026-07-13T10:00:00.000Z"),
  decided_at: null,
};

function repository(query: ReturnType<typeof vi.fn>) {
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release });
  return {
    instance: new PostgresLearningRequestRepository({ connect } as unknown as LearningRequestDatabase),
    connect,
    release,
  };
}

describe("learning-request repository", () => {
  it("rejects a malformed retry id before opening a connection", async () => {
    const query = vi.fn();
    const subject = repository(query);
    await expect(subject.instance.create({ ...input, requestId: "retry-me" }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST_ID" });
    expect(subject.connect).not.toHaveBeenCalled();
  });

  it("creates one request with the learner-scoped client identifier", async () => {
    const query = vi.fn(async (statement: string, _values?: readonly unknown[]) => {
      void _values;
      if (statement === "begin" || statement.startsWith("select pg_advisory")) return { rows: [] };
      if (statement.includes("from learning_request")) return { rows: [] };
      if (statement.startsWith("insert into learning_request")) return { rows: [storedRow] };
      if (statement === "commit") return { rows: [] };
      throw new Error(`Unexpected query: ${statement}`);
    });
    const subject = repository(query);

    await expect(subject.instance.create(input)).resolves.toMatchObject({
      replayed: false,
      request: { id: storedRow.id, subject: input.subject },
    });
    const insert = query.mock.calls.find(([statement]) => String(statement).startsWith("insert into learning_request"));
    expect(insert?.[1]).toEqual([
      input.userId,
      input.requestId,
      input.kind,
      input.subject,
      input.details,
    ]);
    expect(subject.release).toHaveBeenCalledOnce();
  });

  it("returns an exact committed replay without inserting again", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement === "begin" || statement.startsWith("select pg_advisory")) return { rows: [] };
      if (statement.includes("from learning_request")) return { rows: [storedRow] };
      if (statement === "commit") return { rows: [] };
      throw new Error(`Unexpected query: ${statement}`);
    });
    const subject = repository(query);

    await expect(subject.instance.create(input)).resolves.toMatchObject({
      replayed: true,
      request: { id: storedRow.id },
    });
    expect(query.mock.calls.some(([statement]) => String(statement).startsWith("insert into"))).toBe(false);
    expect(subject.release).toHaveBeenCalledOnce();
  });

  it("rejects reuse of the same scoped id with different creation input", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement === "begin" || statement.startsWith("select pg_advisory")) return { rows: [] };
      if (statement.includes("from learning_request")) {
        return { rows: [{ ...storedRow, subject: "A different subject" }] };
      }
      if (statement === "rollback") return { rows: [] };
      throw new Error(`Unexpected query: ${statement}`);
    });
    const subject = repository(query);

    const promise = subject.instance.create(input);
    await expect(promise).rejects.toBeInstanceOf(LearningRequestRepositoryError);
    await expect(promise).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    expect(query).toHaveBeenCalledWith("rollback");
    expect(subject.release).toHaveBeenCalledOnce();
  });

  it("recovers an exact result when a direct writer wins the unique race", async () => {
    let reads = 0;
    const query = vi.fn(async (statement: string) => {
      if (statement === "begin" || statement.startsWith("select pg_advisory")) return { rows: [] };
      if (statement.includes("from learning_request")) {
        reads += 1;
        return { rows: reads === 1 ? [] : [storedRow] };
      }
      if (statement.startsWith("insert into learning_request")) return { rows: [] };
      if (statement === "commit") return { rows: [] };
      throw new Error(`Unexpected query: ${statement}`);
    });
    const subject = repository(query);

    await expect(subject.instance.create(input)).resolves.toMatchObject({
      replayed: true,
      request: { id: storedRow.id },
    });
    expect(reads).toBe(2);
  });
});
