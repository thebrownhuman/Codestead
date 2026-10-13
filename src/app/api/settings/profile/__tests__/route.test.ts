import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authz: vi.fn(), load: vi.fn(), save: vi.fn(), updateUser: vi.fn(), limiter: vi.fn((_policy, action: () => unknown) => action()) }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.authz }));
vi.mock("@/lib/auth", () => ({ auth: { api: { updateUser: mocks.updateUser } } }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.limiter }));
vi.mock("@/lib/preferences/profile-settings", () => ({ loadLearningProfile: mocks.load, saveLearningProfile: mocks.save }));
import { GET, PATCH } from "../route";
afterEach(() => vi.restoreAllMocks());
const profile = { name: "Current", bio: "", analogyFrequency: "helpful", cohortVisibility: "hidden", profileVersion: 1, cohortVersion: 0 };
const body = { name: "  New Name  ", bio: " Bio ", analogyFrequency: "frequent", cohortVisibility: "hidden", profileVersion: 1, cohortVersion: 0, requestId: "b1000000-0000-4000-8000-000000000001" };
function request(value: unknown = body, origin: string | null = "http://localhost:3000") {
  return new NextRequest("http://localhost:3000/api/settings/profile", { method: "PATCH", headers: { "content-type": "application/json", cookie: "session=fake", ...(origin ? { origin } : {}) }, body: JSON.stringify(value) });
}
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("APP_URL", "http://localhost:3000"); mocks.authz.mockResolvedValue({ session: { user: { id: "owner", name: "Current" } }, account: { role: "learner" } }); mocks.load.mockResolvedValue(profile); mocks.save.mockResolvedValue(undefined); mocks.updateUser.mockResolvedValue({ status: true }); });
describe("profile settings boundary", () => {
  it.each(["absent", "truthful", "lying"])("bounds JSON before parsing with %s Content-Length and preserves normal/invalid responses", async (length) => {
    const req = request();
    const oversized = new NextRequest(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(body) + " ".repeat(65_536),
    });
    if (length === "truthful") oversized.headers.set("content-length", String(Buffer.byteLength(JSON.stringify(body) + " ".repeat(65_536))));
    if (length === "lying") oversized.headers.set("content-length", "1");
    const nativeParse = vi.spyOn(oversized, "json");
    const jsonParse = vi.spyOn(JSON, "parse");
    const response = await PATCH(oversized);
    expect(response.status).toBe(413);
    expect(nativeParse).not.toHaveBeenCalled();
    expect(jsonParse.mock.calls.some(([value]) => typeof value === "string" && value.endsWith(" ".repeat(65_536)))).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
    jsonParse.mockRestore();
    expect((await PATCH(request())).status).toBe(200);
    const invalid = new NextRequest(req.url, { method: req.method, headers: req.headers, body: "{" });
    const rejected = await PATCH(invalid);
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toBe('Enter a name of 1–120 characters, a bio of at most 280 characters, and valid preferences.');
  });


  it.each([GET, PATCH])("stops unauthenticated requests before work", async (handler) => {
    mocks.authz.mockResolvedValue({ session: null, response: NextResponse.json({ error: "denied" }, { status: 401 }) });
    expect((await handler(request())).status).toBe(401); expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.updateUser).not.toHaveBeenCalled();
  });
  it("loads only the signed-in profile with no-store", async () => {
    const response = await GET(); expect(await response.json()).toEqual({ profile }); expect(mocks.load).toHaveBeenCalledWith("owner", "Current", "learner"); expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it.each([null, "https://evil.test"])("rejects an unsafe origin %s", async (origin) => {
    expect((await PATCH(request(body, origin))).status).toBe(403); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.updateUser).not.toHaveBeenCalled();
  });
  it.each([{ ...body, name: " " }, { ...body, name: "x".repeat(121) }, { ...body, bio: "x".repeat(281) }, { ...body, analogyFrequency: "invalid" }, { ...body, cohortVisibility: "public" }, { ...body, userId: "other" }])("rejects invalid input %#", async (value) => {
    expect((await PATCH(request(value))).status).toBe(400); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.updateUser).not.toHaveBeenCalled();
  });
  it("rate limits and uses Better Auth updateUser with only the trimmed name", async () => {
    const req = request(); const response = await PATCH(req); expect(response.status).toBe(200);
    expect(mocks.limiter).toHaveBeenCalledWith({ policy: "social_profile_user", identity: { kind: "user", value: "owner" } }, expect.any(Function));
    expect(mocks.save).toHaveBeenCalledWith("owner", "learner", expect.objectContaining({ name: "New Name", bio: "Bio" }));
    expect(mocks.updateUser).toHaveBeenCalledWith({ headers: req.headers, body: { name: "New Name" } });
  });
  it("does not mutate when rate limited", async () => {
    mocks.limiter.mockResolvedValueOnce(NextResponse.json({ error: "limited" }, { status: 429 })); expect((await PATCH(request())).status).toBe(429); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("reports partial failure without leaking provider/auth errors", async () => {
    mocks.updateUser.mockRejectedValueOnce(new Error("private cookie or database body")); const response = await PATCH(request()); expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("private cookie");
  });
});
