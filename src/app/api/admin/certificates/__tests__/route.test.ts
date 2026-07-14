import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/certificates/service", () => ({ listAdminCertificates: mocks.list }));

import { GET } from "../route";

describe("administrator certificate inventory API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ session: { user: { id: "admin-1" } }, response: null });
    mocks.list.mockResolvedValue([]);
  });

  it("requires the administrator boundary", async () => {
    mocks.requireAdmin.mockResolvedValue({ session: null, response: new Response("forbidden", { status: 403 }) });
    expect((await GET()).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("returns the private inventory with no-store policy", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ certificates: [] });
  });
});
