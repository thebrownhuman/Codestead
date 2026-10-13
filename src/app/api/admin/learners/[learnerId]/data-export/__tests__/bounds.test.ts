import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ export: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: { select: () => ({ from: () => ({ where: () => ({
  limit: async () => [{ id: "learner" }],
}) }) }) } }));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: async () => ({
  session: { user: { id: "admin" }, session: { id: "session" } }, account: { role: "admin" },
}) }));
vi.mock("@/lib/data-lifecycle/admin-authorization", () => ({ authorizeLifecycleAdmin: async () => ({ allowed: true }) }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: async (_input: unknown, callback: () => Promise<unknown>) => callback() }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/data-lifecycle/export", () => ({ createLearnerExport: mocks.export }));
import { POST } from "../route";

describe("export bounds HTTP errors", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([
    ["EXPORT_ALREADY_IN_PROGRESS", 429, /already in progress/],
    ["EXPORT_DEADLINE_EXCEEDED", 504, /120-second deadline.*No file was saved/],
  ])("maps %s to a safe error response", async (code, status, message) => {
    mocks.export.mockRejectedValueOnce(Object.assign(new Error("private database detail"), { code }));
    const response = await POST(new NextRequest("https://learn.test/api/admin/export", {
      method: "POST", body: JSON.stringify({
        requestId: "81000000-0000-4000-8000-000000000001", reason: "Learner requested export",
      }),
    }), { params: Promise.resolve({ learnerId: "learner" }) });
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.has("content-disposition")).toBe(false);
    const body = await response.json();
    expect(body.error).toMatch(message);
    expect(JSON.stringify(body)).not.toContain("private database detail");
  });
});
