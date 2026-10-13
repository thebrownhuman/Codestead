import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), load: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: (_: unknown, work: () => unknown) => work() }));
vi.mock("@/lib/ai/learner-model-choice-store", () => ({
  loadLearnerModelSettings: mocks.load, saveLearnerModelChoice: mocks.save,
  ModelChoiceError: class extends Error {},
}));
import { GET, PATCH } from "../route";
import { ModelChoiceError } from "@/lib/ai/learner-model-choice-store";
const key = "10000000-0000-4000-8000-000000000001";
function request(body: unknown, origin = "https://learn.example.test") {
  return new NextRequest(origin + "/api/settings/ai-model", { method: "PATCH", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("APP_URL", "https://learn.example.test"); vi.stubEnv("NODE_ENV", "production");
  mocks.auth.mockResolvedValue({ session: { user: { id: "owner" } } });
  mocks.load.mockResolvedValue({ models: [], selectedKey: null, defaultModel: null, unavailable: false });
  mocks.save.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
it("authenticates before loading or changing preferences", async () => {
  mocks.auth.mockResolvedValue({ session: null, response: NextResponse.json({}, { status: 401 }) });
  expect((await GET()).status).toBe(401); expect((await PATCH(request({ key }))).status).toBe(401);
  expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});
it.each([{ key, userId: "other" }, { key: "invalid" }, { key, provider: "other" }])("rejects non-owner targeting or invalid fields %j", async (body) => {
  expect((await PATCH(request(body))).status).toBe(400); expect(mocks.save).not.toHaveBeenCalled();
});
it.each([key, null])("saves only the session owner's preference %s", async (choice) => {
  expect((await PATCH(request({ key: choice }))).status).toBe(200);
  expect(mocks.save).toHaveBeenCalledWith("owner", choice);
});
it("rejects disabled, unknown or non-tutor models with 400", async () => {
  mocks.save.mockRejectedValue(new ModelChoiceError("Choose a currently enabled tutor model."));
  expect((await PATCH(request({ key }))).status).toBe(400);
});
it("rejects cross-origin updates", async () => {
  expect((await PATCH(request({ key }, "https://foreign.example"))).status).toBe(403);
  expect(mocks.save).not.toHaveBeenCalled();
});
it("keeps settings private and retains disabled-choice notice", async () => {
  mocks.load.mockResolvedValue({ models: [], selectedKey: null, unavailable: true });
  const response = await GET(); expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toMatchObject({ unavailable: true });
});
