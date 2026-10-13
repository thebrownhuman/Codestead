import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), lock: vi.fn(), durable: vi.fn(), gate: vi.fn(), consent: vi.fn(), accepted: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("@/lib/security/user-authority-lock", () => ({ lockUserAuthority: mocks.lock }));
vi.mock("@/lib/exams/capability-gate", () => ({ gateClosedBookCapability: mocks.gate }));
vi.mock("@/lib/privacy/consent", () => ({ getCurrentConsentsFrom: mocks.consent, isCurrentConsentAccepted: mocks.accepted }));
import { brokerControl, cancelInteractiveForExam, withInteractiveAuthority } from "../interactive-control";
import { bodyHash, verifyEnvelope } from "../interactive-protocol.mjs";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async operation => operation({ execute: vi.fn(), select: () => ({
    from: () => ({ innerJoin: () => ({ where: () => ({ limit: mocks.durable }) }) }),
  }) }));
  mocks.durable.mockResolvedValue([{ status: "active", mfaEnabled: true, mustChangePassword: false,
    expiresAt: new Date(Date.now() + 60000), revokedAt: null, mfaVerifiedAt: new Date() }]);
  mocks.gate.mockResolvedValue({ allowed: true }); mocks.consent.mockResolvedValue(new Map()); mocks.accepted.mockReturnValue(true);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("acquires global authority before rechecking durable auth, exam/consent, then admitting", async () => {
  const operation = vi.fn().mockResolvedValue("admitted");
  await expect(withInteractiveAuthority("alice", "device-a", operation)).resolves.toBe("admitted");
  const order = [mocks.lock, mocks.durable, mocks.gate, mocks.consent, operation].map(mock => mock.mock.invocationCallOrder[0]);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});
it("a revoked or missing owner-bound durable login discovered after the lock prevents admission", async () => {
  const operation = vi.fn(); mocks.durable.mockResolvedValue([]);
  await expect(withInteractiveAuthority("alice", "device-a", operation)).rejects.toMatchObject({ status: 401 });
  mocks.durable.mockResolvedValue([{ status: "active", revokedAt: new Date(), expiresAt: new Date(Date.now() + 60000) }]);
  await expect(withInteractiveAuthority("alice", "device-a", operation)).rejects.toMatchObject({ status: 401 });
  expect(operation).not.toHaveBeenCalled();
});
it.each([["active", 423], ["paused_by_system", 423], ["unavailable", 503]] as const)("denies %s exam authority before doing broker work", async (_state, status) => {
  const operation = vi.fn(); mocks.gate.mockResolvedValue({ allowed: false, code: status === 503 ? "EXAM_STATE_UNAVAILABLE" : "EXAM_CLOSED_BOOK", status });
  await expect(withInteractiveAuthority("alice", "device-a", operation)).rejects.toMatchObject({ status });
  await expect(mocks.transaction.mock.results[0].value).resolves.toMatchObject({ error: { status } });
  expect(operation).not.toHaveBeenCalled();
});
it.each([{ status: "suspended" }, { mfaEnabled: false }, { mustChangePassword: true },
  { expiresAt: new Date(0) }, { expiresAt: new Date(NaN) }, { mfaVerifiedAt: null }])("rechecks account/session policy under the lock (%j)", async changed => {
  mocks.durable.mockResolvedValue([{ status: "active", mfaEnabled: true, mustChangePassword: false,
    expiresAt: new Date(Date.now() + 60000), revokedAt: null, mfaVerifiedAt: new Date(), ...changed }]);
  const operation = vi.fn();
  await expect(withInteractiveAuthority("alice", "device-a", operation)).rejects.toMatchObject({ status: 401 });
  expect(operation).not.toHaveBeenCalled();
});
it("consent rejection prevents broker work", async () => {
  const operation = vi.fn(); mocks.accepted.mockReturnValue(false);
  await expect(withInteractiveAuthority("alice", "device-a", operation)).rejects.toMatchObject({ status: 409 });
  expect(operation).not.toHaveBeenCalled();
});
it("flag OFF leaves existing exam admission independent of broker availability", async () => {
  vi.stubEnv("INTERACTIVE_RUNNER_ENABLED", "false"); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await cancelInteractiveForExam("alice"); expect(fetch).not.toHaveBeenCalled();
});
it("enabled exam admission fails closed without cancellation acknowledgement", async () => {
  vi.stubEnv("INTERACTIVE_RUNNER_ENABLED", "true"); vi.stubEnv("INTERACTIVE_BROKER_SECRET", "test-only-secret-of-at-least-32-bytes");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "CANCELLATION_UNCONFIRMED" }), { status: 503 })));
  await expect(cancelInteractiveForExam("alice")).rejects.toMatchObject({ status: 503, code: "CANCELLATION_UNCONFIRMED" });
});
it("binds the private control proof to method/path/exact bytes and refuses redirects", async () => {
  vi.stubEnv("INTERACTIVE_BROKER_SECRET", "test-only-secret-of-at-least-32-bytes");
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: "test-id" }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await expect(brokerControl({ action: "cancel-user", userId: "alice" })).resolves.toMatchObject({ sessionId: "test-id" });
  const options = fetch.mock.calls[0][1];
  expect(options.redirect).toBe("error"); expect(options.cache).toBe("no-store");
  expect(verifyEnvelope(process.env.INTERACTIVE_BROKER_SECRET!, "control", options.headers["x-interactive-proof"]))
    .toMatchObject({ method: "POST", path: "/control", bodyHash: bodyHash(options.body) });
});
it("returns a fixed code on transport failure or invalid configured origin", async () => {
  vi.stubEnv("INTERACTIVE_BROKER_SECRET", "test-only-secret-of-at-least-32-bytes");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("raw-private-error")));
  await expect(brokerControl({})).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE", status: 503 });
  vi.stubEnv("INTERACTIVE_BROKER_URL", "https://invalid.test/path");
  await expect(brokerControl({})).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE", status: 503 });
});
