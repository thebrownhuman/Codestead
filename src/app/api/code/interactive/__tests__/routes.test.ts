import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signEnvelope } from "@/lib/runner/interactive-protocol.mjs";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), control: vi.fn(), authority: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: async (_rules: unknown, operation: () => Promise<Response>) => operation() }));
vi.mock("@/lib/runner/interactive-control", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/runner/interactive-control")>();
  return { ...real, brokerControl: mocks.control, withInteractiveAuthority: mocks.authority };
});
import { POST } from "@/app/api/code/interactive/route";
import { DELETE } from "@/app/api/code/interactive/[sessionId]/route";
import { GET } from "@/app/api/code/interactive/[sessionId]/authorize/route";
import { InteractiveError } from "@/lib/runner/interactive-control";

const id = "10000000-0000-4000-8000-000000000001";
const origin = "https://learn.test";
const context = { params: Promise.resolve({ sessionId: id }) };
function request(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(origin + "/api/code/interactive", { method,
    headers: { origin, "sec-fetch-site": "same-origin", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
describe("interactive routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("INTERACTIVE_RUNNER_ENABLED", "true");
    vi.stubEnv("APP_URL", origin);
    vi.stubEnv("INTERACTIVE_BROKER_SECRET", randomBytes(32).toString("hex"));
    mocks.auth.mockResolvedValue({ session: { user: { id: "alice" }, session: { id: "device-a" } }, response: null });
    mocks.authority.mockImplementation(async (_user: string, _session: string, operation: () => Promise<unknown>) => operation());
    mocks.control.mockResolvedValue({ sessionId: id, grant: "test-only" });
  });
  afterEach(() => { vi.unstubAllEnvs(); });
  it("returns 404 before auth when the feature is OFF", async () => {
    vi.stubEnv("INTERACTIVE_RUNNER_ENABLED", "false");
    expect((await POST(request("POST", {}))).status).toBe(404);
    expect((await DELETE(request("DELETE"), context)).status).toBe(404);
    expect((await GET(request("GET"), context)).status).toBe(404);
    expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.control).not.toHaveBeenCalled();
  });
  it("requires authentication on all enabled routes", async () => {
    mocks.auth.mockResolvedValue({ session: null, response: NextResponse.json({}, { status: 401 }) });
    expect((await POST(request("POST", {}))).status).toBe(401);
    expect((await DELETE(request("DELETE"), context)).status).toBe(401);
    expect((await GET(request("GET"), context)).status).toBe(401);
    expect(mocks.control).not.toHaveBeenCalled();
  });
  it("rejects cross-origin create, cancellation and GET upgrade authorization", async () => {
    const headers = { origin: "https://evil.test" };
    expect((await POST(request("POST", {}, headers))).status).toBe(403);
    expect((await DELETE(request("DELETE", undefined, headers), context)).status).toBe(403);
    expect((await GET(request("GET", undefined, headers), context)).status).toBe(403);
    expect(mocks.control).not.toHaveBeenCalled();
  });
  it.each([ { mode: "exam" }, { attemptId: id }, { graded: true }, { stdin: "1\n" }, { limits: { cpuMs: 9999 } } ])("rejects non-practice fields: %j", async extra => {
    const response = await POST(request("POST", { mode: "practice", language: "python", source: "input()", ...extra }));
    expect(response.status).toBe(400); expect(mocks.control).not.toHaveBeenCalled();
  });
  it("charges source UTF-8 bytes and uses pinned Piston version", async () => {
    expect((await POST(request("POST", { mode: "practice", language: "python", source: "😀".repeat(32769) }))).status).toBe(400);
    const response = await POST(request("POST", { mode: "practice", language: "python", source: "input()" }));
    expect(response.status).toBe(201);
    expect(mocks.control).toHaveBeenCalledWith(expect.objectContaining({ action: "create", userId: "alice", authSessionId: "device-a",
      init: expect.objectContaining({ language: "python", version: "3.14.8" }) }));
    expect(await response.json()).toMatchObject({ officialMasteryEvidence: false });
  });
  it.each([423, 503, 409])("fails closed on exam/DB/consent rejection (%i)", async status => {
    mocks.authority.mockRejectedValue(new InteractiveError("POLICY_REJECTED", status));
    expect((await POST(request("POST", { mode: "practice", language: "python", source: "input()" }))).status).toBe(status);
    expect(mocks.control).not.toHaveBeenCalled();
  });
  it("scopes Stop to the durable login owner", async () => {
    expect((await DELETE(request("DELETE"), context)).status).toBe(204);
    expect(mocks.control).toHaveBeenCalledWith({ action: "cancel", sessionId: id, userId: "alice", authSessionId: "device-a" });
  });
  it("rejects missing, expired and cross-user private upgrade proof", async () => {
    expect((await GET(request("GET"), context)).status).toBe(403);
    for (const [userId, time] of [["bob", Date.now()], ["alice", Date.now() - 60000]] as const) {
      const proof = signEnvelope(process.env.INTERACTIVE_BROKER_SECRET!, "authorize", { action: "activate", userId, authSessionId: "device-a", sessionId: id }, time);
      expect((await GET(request("GET", undefined, { "x-interactive-proof": proof }), context)).status).toBe(userId === "bob" ? 404 : 403);
    }
    expect(mocks.control).not.toHaveBeenCalled();
  });
  it("activates only a matching signed owner under the authority lock", async () => {
    const proof = signEnvelope(process.env.INTERACTIVE_BROKER_SECRET!, "authorize", { action: "activate", userId: "alice", authSessionId: "device-a", sessionId: id });
    expect((await GET(request("GET", undefined, { "x-interactive-proof": proof }), context)).status).toBe(204);
    expect(mocks.authority).toHaveBeenCalledWith("alice", "device-a", expect.any(Function));
    expect(mocks.control).toHaveBeenCalledWith({ action: "activate", sessionId: id, userId: "alice", authSessionId: "device-a" });
  });
});
