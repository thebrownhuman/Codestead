import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ writeAuditEvent: vi.fn() }));

vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));

import { writeAuditEventSafely } from "../audit-safe";

const input = {
  actorUserId: "admin-1",
  action: "curriculum.rollback",
  resourceType: "course",
  resourceId: "course-1",
  reason: "private admin reason",
  outcome: "success" as const,
  metadata: { secret: "must not be logged" },
};

describe("writeAuditEventSafely", () => {
  afterEach(() => { vi.restoreAllMocks(); mocks.writeAuditEvent.mockReset(); });

  it("returns the written audit receipt", async () => {
    mocks.writeAuditEvent.mockResolvedValueOnce({ correlationId: "corr-1", eventHash: "h" });
    await expect(writeAuditEventSafely(input)).resolves.toEqual({ correlationId: "corr-1", eventHash: "h" });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(input);
  });

  it("logs a structured event without reason, metadata or error text and returns null", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.writeAuditEvent.mockRejectedValueOnce(new TypeError("postgres://user:secret@db failed"));

    await expect(writeAuditEventSafely(input)).resolves.toBeNull();

    expect(errorLog).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      event: "audit.write_failed",
      action: "curriculum.rollback",
      outcome: "success",
      resourceType: "course",
      resourceId: "course-1",
      errorName: "TypeError",
    }));
  });

  it("logs a missing resource id as null and a non-Error rejection by a fixed name", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.writeAuditEvent.mockRejectedValueOnce("boom");

    await expect(writeAuditEventSafely({ ...input, resourceId: undefined })).resolves.toBeNull();

    expect(JSON.parse(String(errorLog.mock.calls[0]?.[0]))).toMatchObject({
      resourceId: null,
      errorName: "UnknownError",
    });
  });
});
