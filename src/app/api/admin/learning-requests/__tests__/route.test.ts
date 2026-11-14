import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), select: vi.fn(), where: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.auth }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
import { GET } from "../route";
describe("admin request list boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.auth.mockResolvedValue({ session: { user: { id: "admin" } } });
    const chain = { from: vi.fn(() => chain), innerJoin: vi.fn(() => chain), where: mocks.where.mockImplementation(() => chain), orderBy: vi.fn(() => chain), limit: mocks.limit.mockResolvedValue([]) };
    mocks.select.mockReturnValue(chain);
  });
  it("blocks learners and anonymous callers before database reads", async () => {
    for (const status of [401, 403]) {
      mocks.auth.mockResolvedValueOnce({ session: null, response: NextResponse.json({}, { status }) });
      expect((await GET()).status).toBe(status);
    }
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it("validates filters and reads the support queue without caching", async () => {
    const response = await GET(new NextRequest("http://localhost:3000/api/admin/learning-requests?queue=support&status=resolved"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.where).toHaveBeenCalled();
    expect((await GET(new NextRequest("http://localhost:3000/api/admin/learning-requests?queue=other"))).status).toBe(400);
  });
  it("lists every decided request as resolved and only pending ones as open", async () => {
    const whereFor = async (status: string) => {
      mocks.where.mockClear();
      await GET(new NextRequest(`http://localhost:3000/api/admin/learning-requests?status=${status}`));
      return new PgDialect().sqlToQuery(mocks.where.mock.calls[0]![0] as SQL);
    };
    const resolved = await whereFor("resolved");
    expect(resolved.sql).toContain('"status" <> ');
    expect(resolved.params).toContain("pending");
    expect(resolved.params).not.toContain("approved");
    const open = await whereFor("open");
    expect(open.sql).toContain('"status" = ');
    expect(open.params).toContain("pending");
  });
  it("fails closed when the database is unavailable", async () => {
    mocks.limit.mockRejectedValueOnce(new Error("SQL secret"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("SQL secret");
  });
});
