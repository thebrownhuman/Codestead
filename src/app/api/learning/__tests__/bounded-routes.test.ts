import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  createAttempt: vi.fn(),
  switchDsaLanguage: vi.fn(),
  initializePlans: vi.fn(),
  startSession: vi.fn(),
  recordSessionEvent: vi.fn(),
  mutateSession: vi.fn(),
  submitAttempt: vi.fn(),
  revealNextPracticeHelp: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/learning-service/runtime", () => ({ learningService: mocks }));

import { POST as placement } from "../placement/route";
import { POST as language } from "../dsa/language/route";
import { POST as plans } from "../plans/route";
import { POST as sessions } from "../sessions/route";
import { POST as events } from "../sessions/[sessionId]/events/route";
import { PATCH as session } from "../sessions/[sessionId]/route";
import { POST as attempts } from "../attempts/route";
import { POST as submit } from "../attempts/[attemptId]/submit/route";
import { POST as help } from "../attempts/[attemptId]/help/route";

const id = "50000000-0000-4000-8000-000000000001";
const operations = [
  { route: "placement", method: "POST", cap: 64 * 1024, run: placement },
  { route: "dsa/language", method: "POST", cap: 64 * 1024, run: language },
  { route: "plans", method: "POST", cap: 64 * 1024, run: plans },
  { route: "sessions", method: "POST", cap: 64 * 1024, run: sessions },
  { route: `sessions/${id}/events`, method: "POST", cap: 64 * 1024, run: (request: Request) => events(request, { params: Promise.resolve({ sessionId: id }) }) },
  { route: `sessions/${id}`, method: "PATCH", cap: 64 * 1024, run: (request: Request) => session(request, { params: Promise.resolve({ sessionId: id }) }) },
  { route: "attempts", method: "POST", cap: 64 * 1024, run: attempts },
  { route: `attempts/${id}/submit`, method: "POST", cap: 1024 * 1024, run: (request: Request) => submit(request, { params: Promise.resolve({ attemptId: id }) }) },
  { route: `attempts/${id}/help`, method: "POST", cap: 64 * 1024, run: (request: Request) => help(request, { params: Promise.resolve({ attemptId: id }) }) },
];

function request(route: string, method: string, body: string) {
  return new Request(`https://learn.example.test/api/learning/${route}`, {
    method, headers: { "content-type": "application/json" }, body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ session: { user: { id: "learner-1" } } });
  mocks.submitAttempt.mockResolvedValue({ accepted: true });
});
afterEach(() => vi.restoreAllMocks());

describe.each(operations)("learning JSON boundary: $method $route", ({ route, method, cap, run }) => {
  it.each(["absent", "truthful", "lying"])("rejects oversized bytes before JSON parsing with %s Content-Length", async (length) => {
    const payload = "{}" + " ".repeat(cap);
    const req = request(route, method, payload);
    if (length === "truthful") req.headers.set("content-length", String(Buffer.byteLength(payload)));
    if (length === "lying") req.headers.set("content-length", "1");
    const nativeParse = vi.spyOn(req, "json");
    const parse = vi.spyOn(JSON, "parse");
    const response = await run(req);
    expect(response.status).toBe(413);
    expect(nativeParse).not.toHaveBeenCalled();
    expect(parse.mock.calls.some(([value]) => value === payload)).toBe(false);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.submitAttempt).not.toHaveBeenCalled();
    expect(mocks.createAttempt).not.toHaveBeenCalled();
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it("retains authentication before reading the body", async () => {
    mocks.requireAuth.mockResolvedValue({ session: null, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) });
    const req = request(route, method, " ".repeat(cap + 1));
    const read = vi.spyOn(req.body!, "getReader");
    expect((await run(req)).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it("retains the malformed JSON response", async () => {
    const response = await run(request(route, method, "{"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Learning request fields are invalid.", code: "INVALID_REQUEST", details: { fields: [] },
    });
  });
});

describe("learning answer submission capacity", () => {
  it("accepts a schema-valid UTF-8 answer above 64 KiB", async () => {
    const answer = { text: "\uffff".repeat(63_970) };
    const body = { itemKey: "practice-1", responseRevision: 1, answer, assistanceLevel: "A0", solutionRevealed: false };
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(64_000);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(64 * 1024);
    const response = await submit(request(`attempts/${id}/submit`, "POST", JSON.stringify(body)), { params: Promise.resolve({ attemptId: id }) });
    expect(response.status).toBe(200);
    expect(mocks.submitAttempt).toHaveBeenCalledWith("learner-1", id, expect.objectContaining({ answer }));
  });

  it("retains invalid path validation before reading the body", async () => {
    const req = request("attempts/invalid/submit", "POST", " ".repeat(1024 * 1024 + 1));
    const read = vi.spyOn(req.body!, "getReader");
    const response = await submit(req, { params: Promise.resolve({ attemptId: "invalid" }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_ATTEMPT_ID" });
    expect(read).not.toHaveBeenCalled();
  });
});
